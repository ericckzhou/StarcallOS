import fs from 'fs';
import type { SectionNode } from '../core/domain/types';

// pdfjs-dist 4.x+ is ESM-only and the CommonJS `pdf.js` entry was dropped, so
// we lazy-load the legacy ESM build the first time we segment a PDF and cache
// it for subsequent calls.
interface PdfjsModule {
  getDocument(p: { data: Uint8Array; verbosity?: number }): { promise: Promise<PdfDoc> };
  GlobalWorkerOptions: { workerSrc: string };
}
let _pdfjs: PdfjsModule | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (_pdfjs) return _pdfjs;
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  // pdfjs requires a worker even in Node — an empty workerSrc throws
  // "No GlobalWorkerOptions.workerSrc specified" during getDocument(). Point it
  // at the legacy worker ESM entry (same bare specifier resolution that loaded
  // pdf.mjs above); pdfjs runs it on the main thread via dynamic import.
  mod.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
  _pdfjs = mod;
  return mod;
}

// ─── Pdfjs shims ──────────────────────────────────────────────────────────────

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { height: number; width: number };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
interface PdfTextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e, f] — (e,f) = position in PDF user space
  width: number;
  height: number;
  fontName?: string;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type BlockHint =
  | 'heading'
  | 'subheading'
  | 'body'
  | 'caption'
  | 'footnote'
  | 'formula'
  | 'list_item'
  | 'unknown';

export interface BlockSignals {
  fontSizeRatio: number;    // block font size / page body median — not "is heading"
  yGapAbove: number;        // raw points gap above — not "is paragraph"
  yGapBelow?: number;
  xColumnIndex: 0 | 1;     // column assignment — not "column 2 content"
  isIsolatedLine: boolean;
  isAllCaps: boolean;
  isBold: boolean;
  isItalic?: boolean;
  lineCount?: number;
  blockWidth?: number;
  indentation?: number;
  dominantFont?: string;
  headingDepth?: number;
  pageTopRatio?: number;
  // 0..1 heading-likeness derived from font ratio + bold + spacing + caps +
  // isolation. Independent of the final `hint`; used to gate running-header
  // section injection and as future ranking signal material.
  headingConfidence?: number;
}

export interface SegmentedBlock {
  text: string;
  page: number;
  readingOrder: number;
  signals: BlockSignals;
  hint: BlockHint;
  hintConfidence: 0 | 1 | 2;  // 0=ambiguous 1=likely 2=strong
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface RawItem {
  str: string;
  x: number;
  y: number;        // PDF user space: y=0 at bottom, increases upward
  width: number;
  fontSize: number;
  fontName: string;
  page: number;
}

interface Line {
  items: RawItem[];
  text: string;
  x: number;
  y: number;
  fontSize: number;
  page: number;
}

interface Block {
  lines: Line[];
  text: string;
  x: number;
  y: number;
  yGapAbove: number;
  yGapBelow: number;
  fontSize: number;
  fontName: string;
  page: number;
}

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── Pass 1: raw items from pdfjs ─────────────────────────────────────────────

function toRawItems(pdfItems: PdfTextItem[], page: number): RawItem[] {
  return pdfItems
    .filter(it => it.str.trim().length > 0)
    .map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      // transform[3] is vertical scale ≈ font size for horizontal text
      fontSize: Math.abs(it.transform[3]) || it.height || 10,
      width: it.width,
      fontName: it.fontName ?? '',
      page,
    }));
}

// ─── Pass 2: group items into lines ───────────────────────────────────────────

function groupIntoLines(items: RawItem[]): Line[] {
  if (!items.length) return [];
  // Higher y = higher on page in PDF user space = read first
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let bucket: RawItem[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    const ref = bucket[bucket.length - 1];
    const lineH = Math.max(ref.fontSize, it.fontSize, 6);
    if (Math.abs(it.y - ref.y) < lineH * 0.55) {
      bucket.push(it);
    } else {
      lines.push(makeLine(bucket));
      bucket = [it];
    }
  }
  if (bucket.length) lines.push(makeLine(bucket));
  return lines;
}

function makeLine(items: RawItem[]): Line {
  const byX = [...items].sort((a, b) => a.x - b.x);
  const fontSizes = byX.map(i => i.fontSize).filter(s => s > 0);
  const pieces: string[] = [];
  for (let i = 0; i < byX.length; i++) {
    const item = byX[i];
    const prev = byX[i - 1];
    if (prev) {
      const prevEnd = prev.x + prev.width;
      const gap = item.x - prevEnd;
      const spaceWidth = Math.max(2, median(fontSizes) * 0.22);
      const left = prev.str.trimEnd();
      const right = item.str.trimStart();
      const alreadySpaced = /\s$/.test(prev.str) || /^\s/.test(item.str);
      const shouldJoinHyphen = left.endsWith('-') && /^[A-Za-z]/.test(right);
      if (!alreadySpaced && !shouldJoinHyphen && gap > spaceWidth) pieces.push(' ');
    }
    pieces.push(item.str);
  }
  return {
    items: byX,
    text: pieces.join('').replace(/\s+/g, ' ').trim(),
    x: byX[0].x,
    y: byX[0].y,
    fontSize: median(fontSizes) || 10,
    page: byX[0].page,
  };
}

export const __layoutTest = {
  makeLine,
  classify,
  groupIntoBlocks,
};

// ─── Pass 3: noise filter ─────────────────────────────────────────────────────

function isNoise(line: Line, pageHeight: number): boolean {
  const t = line.text.trim();
  if (/^\d+$/.test(t)) return true;
  if (/^page\s+\d+/i.test(t)) return true;
  if (/^\d+\s*[\/|]\s*\d+$/.test(t)) return true;
  // Running header/footer: short line in top or bottom 6% of page
  const relY = line.y / pageHeight;
  if ((relY > 0.94 || relY < 0.06) && t.length < 80) return true;
  if (isTocLine(t)) return true;
  return false;
}

// "Introduction ............ 12" / "3.2 Foundations . . . . . 42" / wide-gap variants.
// Catches TOC entries and most index lines so they don't pollute the candidate list.
function isTocLine(text: string): boolean {
  const t = text.trim();
  if (t.length < 5 || t.length > 160) return false;
  // Pattern A: text + 3+ dot leaders + trailing page number
  if (/[\.…·]{3,}\s*\d{1,4}\s*$/.test(t)) return true;
  // Pattern B: non-empty text + ≥6 spaces + trailing page number
  if (/^\S.{4,}?\s{6,}\d{1,4}\s*$/.test(t)) return true;
  // Pattern C: dotted leader with intermittent spaces ". . . . ."
  if (/(?:\.\s){4,}\d{1,4}\s*$/.test(t)) return true;
  return false;
}

// ─── Cross-page repeating header / footer detection ──────────────────────────
// Books usually print the chapter title + page number in the margin of every
// page. Even after isNoise drops the obvious page numbers, the chapter-title
// strings survive as candidates. Strategy: scan margin text across all pages,
// mark anything appearing on >40% of pages (only for docs ≥8 pages where the
// signal is statistically meaningful), then filter those texts from the main
// pass.
const REPEAT_FRACTION    = 0.40;
const REPEAT_MIN_PAGES   = 8;
const REPEAT_MARGIN_FRAC = 0.08;          // top / bottom 8 % of page

interface TopMarginInfo {
  pages: Set<number>;
  originals: Map<string, number>;   // original-cased text → frequency
}

function buildRepeatingMarginSet(
  perPageRaw: Array<{ raw: RawItem[]; pageHeight: number }>,
): { repeats: Set<string>; sections: SectionNode[] } {
  if (perPageRaw.length < REPEAT_MIN_PAGES) return { repeats: new Set(), sections: [] };
  const counts = new Map<string, number>();
  // Top-margin text carries the running chapter/section title. We track it
  // separately (with page numbers + original casing) so confirmed repeats can
  // be promoted into section breadcrumbs, not just stripped as noise.
  const topInfo = new Map<string, TopMarginInfo>();
  for (let i = 0; i < perPageRaw.length; i++) {
    const { raw, pageHeight } = perPageRaw[i];
    if (!raw.length) continue;
    const pageNum = i + 1;
    const lines = groupIntoLines(raw);
    const seenOnPage = new Set<string>();
    for (const ln of lines) {
      const relY = ln.y / pageHeight;
      const inTop = relY > 1 - REPEAT_MARGIN_FRAC;
      const inBottom = relY < REPEAT_MARGIN_FRAC;
      if (inTop || inBottom) {
        const norm = ln.text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#');
        if (norm.length >= 2 && norm.length < 100) {
          seenOnPage.add(norm);
          if (inTop) {
            let info = topInfo.get(norm);
            if (!info) { info = { pages: new Set(), originals: new Map() }; topInfo.set(norm, info); }
            info.pages.add(pageNum);
            const orig = ln.text.trim().replace(/\s+/g, ' ');
            info.originals.set(orig, (info.originals.get(orig) ?? 0) + 1);
          }
        }
      }
    }
    for (const n of seenOnPage) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.floor(perPageRaw.length * REPEAT_FRACTION));
  const repeats = new Set<string>();
  for (const [text, count] of counts) {
    if (count >= threshold) repeats.add(text);
  }

  // Promote confirmed top-margin repeats into coarse (level-1) section nodes.
  const byTitle = new Map<string, { page_start: number; page_end: number }>();
  for (const [norm, info] of topInfo) {
    if (!repeats.has(norm)) continue;
    if (info.pages.size < threshold) continue;
    const bestOriginal = [...info.originals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const title = cleanHeaderTitle(bestOriginal);
    if (!isValidHeaderTitle(title)) continue;
    const pages = [...info.pages];
    const lo = Math.min(...pages);
    const hi = Math.max(...pages);
    const existing = byTitle.get(title);
    if (existing) {
      existing.page_start = Math.min(existing.page_start, lo);
      existing.page_end = Math.max(existing.page_end, hi);
    } else {
      byTitle.set(title, { page_start: lo, page_end: hi });
    }
  }
  const sections: SectionNode[] = [...byTitle.entries()].map(([heading, span]) => ({
    heading: heading.slice(0, 80),
    level: 1,
    page_start: span.page_start,
    page_end: span.page_end,
  }));
  return { repeats, sections };
}

// Strip page-number runs and decorative separators from a running-header line
// so what remains is the title text. Handles the common book layout where the
// page number sits beside the section name, e.g.:
//   "Page 1  Genesis"      → "Genesis"
//   "Genesis  Page 2"      → "Genesis"
//   "2 Samuel  Page 182"   → "2 Samuel"   (leading "2" preserved — it's part of the title)
function cleanHeaderTitle(raw: string): string {
  return raw
    .replace(/\bpage\s+\d+\b/gi, ' ')   // "Page 12" anywhere
    .replace(/\bp\.?\s*\d+\b/gi, ' ')   // "p. 12" / "p12"
    .replace(/[•·|]+/g, ' ')            // decorative separators
    .replace(/^\s*\d+\s*$/, '')         // a line that is only a page number
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidHeaderTitle(title: string): boolean {
  if (title.length < 3 || title.length > 80) return false;
  if (!/[A-Za-z]/.test(title)) return false;          // must contain letters
  if (/^\d+$/.test(title)) return false;
  if (title.split(/\s+/).filter(Boolean).length > 12) return false;
  if (isTocLine(title)) return false;
  return true;
}

function isRepeatingHeader(line: Line, repeats: Set<string>): boolean {
  if (repeats.size === 0) return false;
  const norm = line.text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#');
  return repeats.has(norm);
}

// ─── Pass 4: two-column detection ─────────────────────────────────────────────

function detectColumns(lines: Line[]): { twoCol: boolean; splitX: number } {
  if (lines.length < 12) return { twoCol: false, splitX: 0 };
  const xs = lines.map(l => l.x);
  const med = median(xs);
  const left = xs.filter(x => x < med * 0.75);
  const right = xs.filter(x => x > med * 1.25);
  if (left.length > lines.length * 0.2 && right.length > lines.length * 0.2) {
    return { twoCol: true, splitX: (median(left) + median(right)) / 2 };
  }
  return { twoCol: false, splitX: 0 };
}

// ─── Pass 5: group lines into blocks by y-gap ─────────────────────────────────

function groupIntoBlocks(lines: Line[], medFontSize: number): Block[] {
  if (!lines.length) return [];
  const gapThresh = medFontSize * 1.4;
  const blocks: Block[] = [];
  let bucket: Line[] = [lines[0]];
  let prevY = lines[0].y;

  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(prevY - lines[i].y);
    if (gap > gapThresh) {
      blocks.push(makeBlock(bucket, gap));
      bucket = [lines[i]];
    } else {
      bucket.push(lines[i]);
    }
    prevY = lines[i].y;
  }
  if (bucket.length) blocks.push(makeBlock(bucket, 0));
  return blocks;
}

function makeBlock(lines: Line[], yGapAbove: number): Block {
  const text = lines.map(l => l.text).filter(Boolean).join('\n').trim();
  const fontSizes = lines.flatMap(l => l.items.map(i => i.fontSize)).filter(s => s > 0);
  const freq = new Map<string, number>();
  for (const f of lines.flatMap(l => l.items.map(i => i.fontName))) {
    freq.set(f, (freq.get(f) ?? 0) + 1);
  }
  const dominantFont = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return {
    lines,
    text,
    x: Math.min(...lines.map(l => l.x)),
    y: lines[0].y,
    yGapAbove,
    yGapBelow: 0,
    fontSize: median(fontSizes) || 10,
    fontName: dominantFont,
    page: lines[0].page,
  };
}

// ─── Pass 6: classify — signals + hint, no special-casing ────────────────────

function classify(
  block: Block,
  bodyFontSize: number,
  twoCol: boolean,
  splitX: number,
  readingOrder: number,
  pageHeight: number,
): SegmentedBlock {
  const ratio = bodyFontSize > 0 ? block.fontSize / bodyFontSize : 1;
  const text = block.text;
  const trimmed = text.trim();
  const tokenCount = trimmed.split(/\s+/).filter(Boolean).length;
  const isAllCaps = /[A-Z]/.test(text) && text === text.toUpperCase() && text.length > 2;
  const isBold = /bold|black|heavy/i.test(block.fontName);
  const isItalic = /italic|oblique/i.test(block.fontName);
  const isIsolatedLine = block.lines.length === 1 && text.length < 120;
  const xColumnIndex: 0 | 1 = twoCol && block.x > splitX ? 1 : 0;
  const lineWidths = block.lines.map(l => {
    const xs = l.items.map(i => i.x);
    const ends = l.items.map(i => i.x + i.width);
    return Math.max(...ends) - Math.min(...xs);
  });
  const blockWidth = Math.max(0, ...lineWidths);
  const pageTopRatio = pageHeight > 0 ? block.y / pageHeight : 0;
  const hasSectionNumber = /^\d+(?:\.\d+){0,5}\s+\S/.test(trimmed);
  const headingDepth = hasSectionNumber ? (trimmed.match(/^\d+(?:\.\d+)*/)?.[0].split('.').length ?? 1) : undefined;
  const sentenceLike = tokenCount > 9 || /[.!?]\s*$/.test(trimmed) || /^(this|these|those|when|where|because|although|if|in this|for example)\b/i.test(trimmed);
  const captionLike = /^(fig(?:ure)?|table|algorithm|example|ex\.|eq(?:uation)?)[\s.:_-]*\d*/i.test(trimmed);
  const tocLike = isTocLine(trimmed);
  const formulaLike = /[∑∫∂∇≤≥αβγδεζθλμπσφψω]|\\[a-zA-Z]+[{_^]|[a-zA-Z]\s*=\s*[^=]/.test(trimmed);
  const bigGap = block.yGapAbove > bodyFontSize * 1.1 || block.yGapBelow > bodyFontSize * 1.1;
  // Short, isolated ALL-CAPS lines are almost always section labels even when
  // the font is not enlarged (common in technical books that set headings in
  // small caps at body size). tokenCount guard keeps acronym-laden prose out.
  const allCapsHeading = isAllCaps && isIsolatedLine && tokenCount <= 8;
  const typographyHeading =
    (ratio >= 1.32 && isIsolatedLine) ||
    (ratio >= 1.12 && isBold && isIsolatedLine && bigGap) ||
    (allCapsHeading && (bigGap || ratio >= 1.0)) ||
    (hasSectionNumber && isIsolatedLine && (isBold || ratio >= 1.08));

  // headingConfidence: 0..1 heading-likeness, computed regardless of final hint.
  let headingConfidence = 0;
  headingConfidence += Math.max(0, Math.min(1, (ratio - 1) / 0.6)) * 0.4;
  if (isBold)          headingConfidence += 0.20;
  if (isAllCaps)       headingConfidence += 0.15;
  if (isIsolatedLine)  headingConfidence += 0.15;
  if (bigGap)          headingConfidence += 0.10;
  if (hasSectionNumber) headingConfidence += 0.10;
  if (sentenceLike || captionLike || tocLike || formulaLike) headingConfidence *= 0.3;
  headingConfidence = Math.max(0, Math.min(1, headingConfidence));

  let hint: BlockHint = 'unknown';
  let hintConfidence: 0 | 1 | 2 = 0;

  if (captionLike || tocLike) {
    hint = 'caption';
    hintConfidence = tocLike ? 2 : 1;
  } else if (formulaLike) {
    hint = 'formula';
    hintConfidence = 1;
  } else if (typographyHeading && !sentenceLike) {
    hint = ratio >= 1.45 || headingDepth === 1 ? 'heading' : 'subheading';
    hintConfidence = ratio >= 1.32 || hasSectionNumber || (allCapsHeading && bigGap) ? 2 : 1;
  } else if (ratio < 0.82 && isIsolatedLine) {
    hint = 'caption';
    hintConfidence = 1;
  } else if (ratio < 0.78) {
    hint = 'footnote';
    hintConfidence = 1;
  } else if (/^[•\-*]\s|^\d+[.)]\s/.test(text.trimStart())) {
    hint = 'list_item';
    hintConfidence = 2;
  } else if (ratio >= 0.82) {
    hint = 'body';
    hintConfidence = text.length > 60 ? 2 : 1;
  }

  return {
    text,
    page: block.page,
    readingOrder,
    signals: {
      fontSizeRatio: +ratio.toFixed(2),
      yGapAbove: Math.round(block.yGapAbove),
      yGapBelow: Math.round(block.yGapBelow),
      xColumnIndex,
      isIsolatedLine,
      isAllCaps,
      isBold,
      isItalic,
      lineCount: block.lines.length,
      blockWidth: Math.round(blockWidth),
      indentation: Math.round(block.x),
      dominantFont: block.fontName,
      headingDepth,
      pageTopRatio: +pageTopRatio.toFixed(3),
      headingConfidence: +headingConfidence.toFixed(2),
    },
    hint,
    hintConfidence,
  };
}

// ─── Public: PDF segmenter ────────────────────────────────────────────────────

export interface LayoutDiagnostics {
  pages_with_text: number;
  unknown_hint_rate: number;       // 0–1
  formula_block_count: number;
  heading_block_count: number;
  body_block_count: number;
  two_column_pages: number;
  noise_removed_count: number;     // includes TOC lines (matched by isTocLine inside isNoise)
  repeating_header_stripped: number;
  running_header_sections: number;
  merged_broken_headings: number;
  index_blocks_stripped: number;
  avg_blocks_per_page: number;
}

export async function segmentPdf(filePath: string): Promise<{
  blocks: SegmentedBlock[];
  pageCount: number;
  diagnostics: LayoutDiagnostics;
  runningHeaderSections: SectionNode[];
}> {
  const data = fs.readFileSync(filePath);
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0 }).promise;
  const pageCount = doc.numPages;
  const allBlocks: SegmentedBlock[] = [];
  let globalOrder = 0;

  let pagesWithText = 0;
  let twoColumnPages = 0;
  let noiseRemovedCount = 0;
  let repeatingHeaderStrippedCount = 0;

  const debug = process.env.STARCALL_LAYOUT_DEBUG === '1';

  // ─── Pre-pass: gather raw items per page so we can find repeating margin text
  //     across the whole doc before the main strip pass runs.
  const perPageRaw: Array<{ raw: RawItem[]; pageHeight: number }> = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum);
    const { height: pageHeight } = page.getViewport({ scale: 1.0 });
    const { items } = await page.getTextContent();
    const rawItems = toRawItems(items, pageNum);
    perPageRaw.push({ raw: rawItems, pageHeight });
  }
  const { repeats: repeatingHeaders, sections: runningHeaderSections } = buildRepeatingMarginSet(perPageRaw);
  if (debug && repeatingHeaders.size > 0) {
    console.log(`[LAYOUT] repeating margin texts detected (${repeatingHeaders.size}): ${[...repeatingHeaders].slice(0, 5).join(' | ')}`);
  }
  if (debug && runningHeaderSections.length > 0) {
    console.log(`[LAYOUT] running-header sections (${runningHeaderSections.length}): ${runningHeaderSections.slice(0, 5).map(s => `${s.heading}[${s.page_start}-${s.page_end}]`).join(' | ')}`);
  }

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const { raw: rawItems, pageHeight } = perPageRaw[pageNum - 1];
    if (debug && pageNum <= 3) {
      const sample = rawItems.slice(0, 3).map(i => JSON.stringify(i.str)).join(' | ');
      console.log(`[LAYOUT] p${pageNum} kept=${rawItems.length} sample=[${sample}]`);
    }
    if (!rawItems.length) continue;
    pagesWithText++;

    let lines = groupIntoLines(rawItems);
    const linesBefore = lines.length;
    lines = lines.filter(l => {
      if (isNoise(l, pageHeight)) return false;
      if (isRepeatingHeader(l, repeatingHeaders)) {
        repeatingHeaderStrippedCount += 1;
        return false;
      }
      return true;
    });
    noiseRemovedCount += linesBefore - lines.length;
    if (debug && pageNum <= 3) {
      console.log(`[LAYOUT] p${pageNum} lines=${linesBefore} after_noise=${lines.length}`);
    }
    if (!lines.length) continue;

    const { twoCol, splitX } = detectColumns(lines);
    if (twoCol) twoColumnPages++;

    const sorted = twoCol
      ? [
          ...lines.filter(l => l.x <= splitX).sort((a, b) => b.y - a.y),
          ...lines.filter(l => l.x > splitX).sort((a, b) => b.y - a.y),
        ]
      : [...lines].sort((a, b) => b.y - a.y);

    const fontSizes = rawItems.map(i => i.fontSize).filter(s => s > 0);
    const bodyFontSize = median(fontSizes);
    const blocks = groupIntoBlocks(sorted, bodyFontSize || 10);
    for (let i = 0; i < blocks.length; i++) {
      const next = blocks[i + 1];
      blocks[i].yGapBelow = next ? Math.abs(blocks[i].y - next.y) : 0;
    }

    let pushed = 0;
    for (const block of blocks) {
      if (!block.text) continue;
      const seg = classify(block, bodyFontSize, twoCol, splitX, globalOrder, pageHeight);
      if ((seg.hint === 'footnote' || seg.hint === 'caption') && seg.text.length < 25) continue;
      allBlocks.push(seg);
      globalOrder++;
      pushed++;
    }
    if (debug && pageNum <= 3) {
      console.log(`[LAYOUT] p${pageNum} blocks=${blocks.length} pushed=${pushed} bodyFont=${bodyFontSize.toFixed(1)}`);
    }
  }

  const mergedBlocks = mergeBrokenHeadings(allBlocks);
  const mergedHeadingCount = allBlocks.length - mergedBlocks.length;
  const beforeIndexStrip = mergedBlocks.length;
  const postIndexBlocks = stripIndexRegion(mergedBlocks);
  const indexStrippedCount = beforeIndexStrip - postIndexBlocks.length;

  const diagnostics: LayoutDiagnostics = {
    pages_with_text:     pagesWithText,
    unknown_hint_rate:   postIndexBlocks.length === 0 ? 0
                         : +(postIndexBlocks.filter(b => b.hint === 'unknown').length / postIndexBlocks.length).toFixed(3),
    formula_block_count: postIndexBlocks.filter(b => b.hint === 'formula').length,
    heading_block_count: postIndexBlocks.filter(b => b.hint === 'heading' || b.hint === 'subheading').length,
    body_block_count:    postIndexBlocks.filter(b => b.hint === 'body').length,
    two_column_pages:    twoColumnPages,
    noise_removed_count: noiseRemovedCount,
    repeating_header_stripped: repeatingHeaderStrippedCount,
    running_header_sections: runningHeaderSections.length,
    merged_broken_headings: mergedHeadingCount,
    index_blocks_stripped: indexStrippedCount,
    avg_blocks_per_page: pagesWithText === 0 ? 0
                         : +(postIndexBlocks.length / pagesWithText).toFixed(2),
  };

  return { blocks: postIndexBlocks, pageCount, diagnostics, runningHeaderSections };
}

// After-the-fact filter: once we see a heading whose text is exactly "Index"
// (or close variants) near the end of the doc, drop everything from that
// heading onward. Index entries otherwise pollute the candidate list with
// alphabetical short phrases that have nothing to do with the book's content.
function stripIndexRegion(blocks: SegmentedBlock[]): SegmentedBlock[] {
  if (blocks.length === 0) return blocks;
  // Look only in the last 25% of the doc to avoid stripping a body mention of
  // the word "index" early on.
  const cutoffStart = Math.floor(blocks.length * 0.75);
  for (let i = blocks.length - 1; i >= cutoffStart; i--) {
    const b = blocks[i];
    if (b.hint !== 'heading' && b.hint !== 'subheading') continue;
    const norm = b.text.trim().toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (norm === 'index' || norm === 'subject index' || norm === 'name index' || norm === 'general index') {
      // Strip this block and everything after.
      return blocks.slice(0, i);
    }
  }
  return blocks;
}

// Concatenate consecutive heading-classified blocks when the first one ends
// mid-word ("Few-") or lacks terminal punctuation AND the next has the same
// font-size class. Catches split headings across line/page breaks like
// "In-Context Learning: Zero-Shot and Few-" + "Shot".
function mergeBrokenHeadings(blocks: SegmentedBlock[]): SegmentedBlock[] {
  if (blocks.length < 2) return blocks;
  const out: SegmentedBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const cur  = blocks[i];
    const next = blocks[i + 1];
    if (
      next &&
      (cur.hint === 'heading' || cur.hint === 'subheading') &&
      (next.hint === 'heading' || next.hint === 'subheading') &&
      cur.hintConfidence >= 1 && next.hintConfidence >= 1 &&
      Math.abs(cur.signals.fontSizeRatio - next.signals.fontSizeRatio) < 0.05 &&
      isUnterminatedHeading(cur.text) &&
      next.text.length < 60
    ) {
      out.push({
        ...cur,
        text: joinHeadingFragments(cur.text, next.text),
      });
      i += 2;
      continue;
    }
    out.push(cur);
    i += 1;
  }
  return out;
}

function isUnterminatedHeading(t: string): boolean {
  const s = t.trim();
  if (!s || s.length > 80) return false;
  if (s.endsWith('-')) return true;
  // No terminal punctuation AND doesn't look like a complete title (single token of digits etc.)
  if (/[.!?:;]\s*$/.test(s)) return false;
  // Ends with a lowercase word-boundary letter — strong continuation signal for headings
  return /[a-zA-Z]$/.test(s);
}

function joinHeadingFragments(a: string, b: string): string {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim.endsWith('-')) {
    // Soft hyphen — drop dash and join with no space ("Few-" + "Shot" → "Few-Shot")
    return aTrim.slice(0, -1) + bTrim;
  }
  return aTrim + ' ' + bTrim;
}

// ─── Public: text source fallback ────────────────────────────────────────────

export function segmentTextWithDiagnostics(text: string): { blocks: SegmentedBlock[]; diagnostics: LayoutDiagnostics } {
  const blocks = segmentText(text);
  return {
    blocks,
    diagnostics: {
      pages_with_text:     1,
      unknown_hint_rate:   blocks.length === 0 ? 0
                           : +(blocks.filter(b => b.hint === 'unknown').length / blocks.length).toFixed(3),
      formula_block_count: blocks.filter(b => b.hint === 'formula').length,
      heading_block_count: blocks.filter(b => b.hint === 'heading' || b.hint === 'subheading').length,
      body_block_count:    blocks.filter(b => b.hint === 'body').length,
      two_column_pages:    0,
      noise_removed_count: 0,
      repeating_header_stripped: 0,
      running_header_sections: 0,
      merged_broken_headings: 0,
      index_blocks_stripped: 0,
      avg_blocks_per_page: blocks.length,
    },
  };
}

export function segmentText(text: string): SegmentedBlock[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const out: SegmentedBlock[] = [];
  for (const para of paragraphs) {
    // A paragraph may contain a markdown heading line + a body line jammed
    // together by a single newline. Split those apart so the heading isn't
    // swallowed into the body.
    const subParts: string[] = [];
    let buffer: string[] = [];
    for (const rawLine of para.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const isMdHeading = /^#{1,6}\s+\S/.test(line);
      const isBulletGroup = /^[*\-]\s/.test(line);
      if (isMdHeading || isBulletGroup) {
        if (buffer.length) { subParts.push(buffer.join(' ')); buffer = []; }
        subParts.push(line);
      } else {
        buffer.push(line);
      }
    }
    if (buffer.length) subParts.push(buffer.join(' '));

    for (const block of subParts) {
      out.push(classifyTextBlock(block, out.length));
    }
  }
  return out;
}

function classifyTextBlock(text: string, order: number): SegmentedBlock {
  const isMdHeading  = /^#{1,6}\s+\S/.test(text);
  const isBullet     = /^[*\-]\s/.test(text);
  const isNumberList = /^\d+[.)]\s/.test(text);
  const isAllCaps    = /[A-Z]/.test(text) && text === text.toUpperCase() && text.length > 2;
  const isShort      = text.length < 80;
  const endsClause   = /[.!?]$/.test(text);

  // Real heading: explicit markdown `#`, or a short standalone all-caps line.
  // Lines like "Common activations:" or "* ReLU * sigmoid" are NOT headings.
  let hint: BlockHint = 'body';
  let hintConfidence: 0 | 1 | 2 = 2;
  let ratio = 1.0;

  if (isMdHeading) {
    const level = (text.match(/^#+/) ?? ['#'])[0].length;
    hint = level <= 2 ? 'heading' : 'subheading';
    hintConfidence = 2;
    ratio = level <= 2 ? 1.6 : 1.3;
  } else if (isBullet || isNumberList) {
    hint = 'list_item';
    hintConfidence = 2;
  } else if (isAllCaps && isShort) {
    hint = 'heading';
    hintConfidence = 1;
    ratio = 1.4;
  } else if (isShort && !endsClause && !text.endsWith(':')) {
    // Genuinely short standalone label that doesn't look like a bullet/list/clause.
    // Treat as a weak subheading hint — candidate parser still requires
    // additional evidence (definition pattern, repetition, etc.) to promote.
    hint = 'subheading';
    hintConfidence = 1;
    ratio = 1.2;
  }

  return {
    text,
    page: 1,
    readingOrder: order,
    signals: {
      fontSizeRatio: ratio,
      yGapAbove: 0,
      xColumnIndex: 0,
      isIsolatedLine: isShort,
      isAllCaps,
      isBold: false,
    },
    hint,
    hintConfidence,
  };
}
