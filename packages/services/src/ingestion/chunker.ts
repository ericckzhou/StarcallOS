// Deterministic retrieval chunker (RAG foundation). Turns the existing layout
// blocks (segmentPdf / segmentText) into section-bounded, page-traceable chunks
// for keyword + vector retrieval. Pure TS, zero LLM, no I/O.
//
// Rules, in priority order:
//   1. Never cross a section boundary (section path from buildSectionPath).
//   2. Never split a layout block, except a single block longer than maxChars,
//      which is split at sentence boundaries (then whitespace).
//   3. Never start a chunk with a formula block, and keep short continuations
//      ("where x is ...") attached to the formula before them — so an equation
//      stays with the prose that introduces and explains it (soft: maxChars wins).
//   4. Close a chunk once it reaches targetChars; carry up to overlapChars of
//      trailing whole blocks into the next chunk of the same section.
//
// Running headers that reach the chunker as headings (e.g.
// "32 CHAPTER 1. INDUCTION") are dropped before section paths are built;
// otherwise the section path changes on every page. Since LAYOUT_VERSION 0.5.3,
// layout.ts strips page-numbered headers itself (detectPrintedPageHeaders), so
// this is now a backstop for documents without consistent printed numbering.

import type { SegmentedBlock } from './layout';
import type { SectionNode } from '../core/domain/types';
import { buildSectionPath } from './enrichment';
import { textHash } from '../core/embeddings';

export interface ChunkerOptions {
  targetChars: number;   // close a chunk once it reaches this size
  maxChars: number;      // hard cap (a lone oversized block is split to fit)
  minChars: number;      // a smaller section tail is merged into the previous chunk
  overlapChars: number;  // max chars of trailing whole blocks repeated in the next chunk
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  targetChars: 1000,
  maxChars: 1800,
  minChars: 200,
  overlapChars: 200,
};

export interface ChunkDraft {
  chunk_key: string;      // textHash(text) + '#' + duplicate index in this source
  ordinal: number;
  text: string;
  heading: string | null;
  section_path: string[];
  section_text: string;
  page_start: number;
  page_end: number;
  block_start: number;    // readingOrder of the first contributing block
  block_end: number;      // readingOrder of the last contributing block
  block_count: number;
  has_formula: boolean;
  char_count: number;
  text_hash: string;
}

export interface ChunkerDiagnostics {
  blocks_in: number;
  noise_blocks_dropped: number;
  running_header_blocks_dropped: number;
  oversized_blocks_split: number;
  heading_only_sections_dropped: number;
  chunks: number;
  avg_chars: number;
  max_chars: number;
}

export interface ChunkerResult {
  chunks: ChunkDraft[];
  diagnostics: ChunkerDiagnostics;
}

const HEADING_HINTS = new Set(['heading', 'subheading']);
const RUNNING_HEADER_MIN_PAGES = 3;
const RUNNING_HEADER_MAX_LEN = 120;

function normalizeRunningHeader(text: string): string {
  return text
    .replace(/^\s*\d+\s+/, '')     // leading page number ("32 CHAPTER 1. …")
    .replace(/\s+\d+\s*$/, '')     // trailing page number ("… INDUCTION 33")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// readingOrders of heading-hinted blocks that sit at the top of a page (first
// two blocks) and whose page-number-stripped text repeats at the top of
// >= RUNNING_HEADER_MIN_PAGES distinct pages.
export function findRunningHeaderBlocks(blocks: SegmentedBlock[]): Set<number> {
  const rankOnPage = new Map<number, number>();
  const seenPerPage = new Map<number, number>();
  for (const b of [...blocks].sort((x, y) => x.readingOrder - y.readingOrder)) {
    const n = seenPerPage.get(b.page) ?? 0;
    rankOnPage.set(b.readingOrder, n);
    seenPerPage.set(b.page, n + 1);
  }
  const pagesByKey = new Map<string, Set<number>>();
  const ordersByKey = new Map<string, number[]>();
  for (const b of blocks) {
    if (!HEADING_HINTS.has(b.hint)) continue;
    if ((rankOnPage.get(b.readingOrder) ?? 99) > 1) continue;
    if (b.text.length > RUNNING_HEADER_MAX_LEN) continue;
    const key = normalizeRunningHeader(b.text);
    if (!key) continue;
    if (!pagesByKey.has(key)) { pagesByKey.set(key, new Set()); ordersByKey.set(key, []); }
    pagesByKey.get(key)!.add(b.page);
    ordersByKey.get(key)!.push(b.readingOrder);
  }
  const out = new Set<number>();
  for (const [key, pages] of pagesByKey) {
    if (pages.size >= RUNNING_HEADER_MIN_PAGES) for (const o of ordersByKey.get(key)!) out.add(o);
  }
  // A short section's odd-page header ("0.1. SETS 3") may appear only once.
  // All-caps text ending in a bare page number is a header shape real headings
  // essentially never take; a LEADING number alone ("1 INTRODUCTION") is
  // ambiguous and still requires repetition.
  for (const b of blocks) {
    if (!HEADING_HINTS.has(b.hint) || (rankOnPage.get(b.readingOrder) ?? 99) > 1) continue;
    const t = b.text.trim();
    const letters = t.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase() && /\s\d{1,4}$/.test(t)) out.add(b.readingOrder);
  }
  return out;
}

// Figure labels, axis ticks and stray numbers ("2 5 1") carry no retrievable
// meaning. Formula blocks are always kept — symbols are their content.
function isNoiseBlock(b: SegmentedBlock): boolean {
  const t = b.text.trim();
  if (!t) return true;
  if (b.hint === 'formula') return false;
  const letters = t.match(/\p{L}/gu)?.length ?? 0;
  return letters < 2;
}

const CONTINUATION_RE = /^(where|with|and|or|so|then|hence|thus|i\.e\.|e\.g\.|for all|for every|for each)\b/i;

function isContinuation(b: SegmentedBlock): boolean {
  const t = b.text.trim();
  return t.length < 240 && (CONTINUATION_RE.test(t) || /^[a-z(]/.test(t));
}

// Split one oversized text at sentence ends, then whitespace, into pieces <= max.
export function splitOversized(text: string, max: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const pieces: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) pieces.push(cur.trim()); cur = ''; };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) push();
    cur = cur ? `${cur} ${s}` : s;
  }
  push();
  return pieces;
}

interface Piece {
  text: string;
  block: SegmentedBlock;
}

interface Draft {
  pieces: Piece[];
  path: string[];
  overlapCount: number; // leading pieces carried over from the previous chunk
}

function draftChars(d: Draft): number {
  return d.pieces.reduce((n, p) => n + p.text.length + 1, 0);
}

export function chunkBlocks(
  blocks: SegmentedBlock[],
  runningHeaderSections: SectionNode[] = [],
  options: Partial<ChunkerOptions> = {},
): ChunkerResult {
  const opt: ChunkerOptions = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
  if (opt.maxChars < opt.targetChars) opt.maxChars = opt.targetChars;

  const ordered = [...blocks].sort((a, b) => a.readingOrder - b.readingOrder);
  const runningHeaders = findRunningHeaderBlocks(ordered);
  let noise = 0;
  const kept = ordered.filter(b => {
    if (runningHeaders.has(b.readingOrder)) return false;
    if (isNoiseBlock(b)) { noise++; return false; }
    return true;
  });
  const { paths } = buildSectionPath(kept, runningHeaderSections);

  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let oversizedSplit = 0;

  const flush = (carryOverlap: boolean): Draft | null => {
    if (!cur || cur.pieces.length === 0) { cur = null; return null; }
    drafts.push(cur);
    const prev = cur;
    cur = null;
    if (!carryOverlap || opt.overlapChars <= 0) return null;
    const carried: Piece[] = [];
    let n = 0;
    for (let i = prev.pieces.length - 1; i >= prev.overlapCount; i--) {
      const p = prev.pieces[i];
      if (n + p.text.length > opt.overlapChars) break;
      if (HEADING_HINTS.has(p.block.hint)) break;   // never re-open with a stale heading
      carried.unshift(p);
      n += p.text.length + 1;
    }
    return carried.length ? { pieces: carried, path: prev.path, overlapCount: carried.length } : null;
  };

  const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  for (const b of kept) {
    const path = paths.get(b.readingOrder) ?? [];
    if (cur && !samePath(cur.path, path)) flush(false);

    const text = b.text.trim();
    if (text.length > opt.maxChars) {
      // Oversized block: finish what we have, then emit each piece as its own chunk.
      flush(false);
      oversizedSplit++;
      for (const part of splitOversized(text, opt.maxChars)) {
        drafts.push({ pieces: [{ text: part, block: b }], path, overlapCount: 0 });
      }
      continue;
    }

    if (!cur) cur = { pieces: [], path, overlapCount: 0 };
    const size = draftChars(cur);
    const hasOwn = cur.pieces.length > cur.overlapCount;
    const last = cur.pieces[cur.pieces.length - 1]?.block;
    // A heading never ends a chunk; a formula never starts one; a short
    // continuation stays with the formula it explains.
    const glued = b.hint === 'formula'
      || (last != null && HEADING_HINTS.has(last.hint))
      || (last?.hint === 'formula' && isContinuation(b));
    const overTarget = size + text.length > opt.targetChars;
    const overMax = size + text.length + 1 > opt.maxChars;
    if (hasOwn && (overMax || (overTarget && !glued))) {
      const carried = flush(true);
      cur = carried && draftChars(carried) + text.length + 1 <= opt.maxChars
        ? carried
        : { pieces: [], path, overlapCount: 0 };
    }
    cur.pieces.push({ text, block: b });
  }
  flush(false);

  // Merge a too-small section tail into the previous chunk of the same section.
  const merged: Draft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    const own = d.pieces.slice(d.overlapCount);
    const ownChars = own.reduce((n, p) => n + p.text.length + 1, 0);
    if (prev && samePath(prev.path, d.path) && ownChars < opt.minChars
        && draftChars(prev) + ownChars <= opt.maxChars) {
      prev.pieces.push(...own);
      continue;
    }
    merged.push(d);
  }

  // Heading-only drafts (a heading immediately followed by another heading)
  // carry no content; their text already lives in later chunks' section path.
  let headingOnly = 0;
  const contentful = merged.filter(d => {
    const onlyHeadings = d.pieces.every(p => HEADING_HINTS.has(p.block.hint));
    if (onlyHeadings) headingOnly++;
    return !onlyHeadings;
  });

  const dupCount = new Map<string, number>();
  const chunks: ChunkDraft[] = contentful.map((d, ordinal) => {
    const text = d.pieces.map(p => p.text).join('\n');
    const hash = textHash(text);
    const dup = dupCount.get(hash) ?? 0;
    dupCount.set(hash, dup + 1);
    const pages = d.pieces.map(p => p.block.page);
    const orders = d.pieces.map(p => p.block.readingOrder);
    return {
      chunk_key: `${hash}#${dup}`,
      ordinal,
      text,
      heading: d.path.length ? d.path[d.path.length - 1] : null,
      section_path: [...d.path],
      section_text: d.path.join(' > '),
      page_start: Math.min(...pages),
      page_end: Math.max(...pages),
      block_start: Math.min(...orders),
      block_end: Math.max(...orders),
      block_count: new Set(orders).size,
      has_formula: d.pieces.some(p => p.block.hint === 'formula'),
      char_count: text.length,
      text_hash: hash,
    };
  });

  const total = chunks.reduce((n, c) => n + c.char_count, 0);
  return {
    chunks,
    diagnostics: {
      blocks_in: blocks.length,
      noise_blocks_dropped: noise,
      running_header_blocks_dropped: runningHeaders.size,
      oversized_blocks_split: oversizedSplit,
      heading_only_sections_dropped: headingOnly,
      chunks: chunks.length,
      avg_chars: chunks.length ? Math.round(total / chunks.length) : 0,
      max_chars: chunks.reduce((m, c) => Math.max(m, c.char_count), 0),
    },
  };
}
