// Optional Docling parser (https://github.com/docling-project/docling-serve).
//
// The user runs `docling-serve` themselves (it stays a local HTTP server; the
// app does not bundle Python). This module only:
//   1. converts a PDF through that server's async API into a DoclingDocument
//      (JSON — never Markdown: Markdown would drop the page numbers that
//      citations, the source preview and evidence spans depend on), and
//   2. adapts the DoclingDocument into the same page-tagged SegmentedBlocks the
//      built-in geometry parser produces, so everything downstream (candidate
//      parser, chunker, Ask) is unchanged.
//
// Typography signals are synthesized from Docling's labels, the way
// segmentText does for text sources: Docling already decided what is a
// heading, so a heading gets a heading-like font ratio and the bold/isolated
// flags the candidate parser treats as typography support.
//
// Running headers/footers come back in Docling's `furniture` layer and are
// dropped. Section depth comes from the heading's own numbering ("6.8" → 2),
// because Docling reports every section_header at level 1.

import fs from 'fs';
import path from 'path';
import type { SectionNode } from '../core/domain/types';
import type { BlockHint, LayoutDiagnostics, SegmentedBlock } from './layout';

// Bump when the mapping below changes; it is part of the layout version stamp
// (see doclingLayoutVersion), so a bump marks Docling-parsed sources outdated.
export const DOCLING_ADAPTER_VERSION = '0.1.0';
export const DEFAULT_DOCLING_BASE_URL = 'http://127.0.0.1:5001';

export function doclingLayoutVersion(): string {
  return `docling-${DOCLING_ADAPTER_VERSION}`;
}

// ─── DoclingDocument (the subset we read) ────────────────────────────────────

interface DoclingRef { $ref: string }
interface DoclingProv {
  page_no: number;
  bbox?: { l: number; t: number; r: number; b: number; coord_origin?: string };
}
interface DoclingNode {
  self_ref: string;
  children?: DoclingRef[];
  content_layer?: string;
  label: string;
}
interface DoclingText extends DoclingNode {
  text: string;
  orig?: string;
  level?: number;
  prov?: DoclingProv[];
}
interface DoclingTable extends DoclingNode {
  prov?: DoclingProv[];
  data?: { grid?: Array<Array<{ text?: string }>> };
}
export interface DoclingDocument {
  schema_name: string;
  version: string;
  body: DoclingNode;
  groups?: DoclingNode[];
  texts?: DoclingText[];
  tables?: DoclingTable[];
  pictures?: DoclingNode[];
  pages?: Record<string, { size?: { width: number; height: number }; page_no?: number }>;
}

// The adapter reads schema 1.x; anything else is rejected so the caller falls
// back to the built-in parser instead of silently mis-reading a new format.
export function assertSupportedDoclingDocument(doc: unknown): asserts doc is DoclingDocument {
  const d = doc as Partial<DoclingDocument> | null;
  if (!d || d.schema_name !== 'DoclingDocument' || typeof d.version !== 'string' || !d.version.startsWith('1.') || !d.body) {
    throw new Error(`Unsupported Docling output (schema ${d?.schema_name ?? '?'} ${d?.version ?? '?'}).`);
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

// "6.8 Logical implication" → 2 · "7 Finite automata" / "Chapter 7 …" → 1.
export function headingDepthFromNumbering(text: string): number | null {
  const t = text.trim();
  if (/^(chapter|part)\s+[\dIVXLC]+\b/i.test(t)) return 1;
  const m = t.match(/^(\d+(?:\.\d+)*)\.?\s+\S/);
  if (!m) return null;
  return Math.min(4, m[1].split('.').length);
}

const RATIO_BY_DEPTH = [1.6, 1.6, 1.35, 1.2, 1.1];

function isAllCaps(text: string): boolean {
  return /[A-Z]/.test(text) && text === text.toUpperCase() && text.length > 2;
}

// Running-header text with page numbers and punctuation removed, so
// "96 CHAPTER 3. FUNCTIONS" and "CHAPTER 3. FUNCTIONS 97" share one key.
function furnitureKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

// Post-pass over the adapted blocks:
// - A heading that is really a running header (Docling occasionally labels one
//   section_header instead of page_header) is dropped: its text equals a
//   running header exactly, or it is an ALL-CAPS running header carrying a page
//   number ("24 CHAPTER 1. INDUCTION"). Matching on the letters alone is NOT
//   enough: many books use the section title itself as the running header, and
//   the real "6.9 Prenex normal form" heading must survive.
// - A bare "Chapter N" heading followed on the same page by an unnumbered
//   title heading is dropped and the title promoted to a depth-1 heading, so
//   the chapter's term is the title ("INDUCTION"), as with the built-in parser.
function cleanHeadings(blocks: SegmentedBlock[], furnitureKeys: Set<string>, furnitureRaw: Set<string>) {
  const kept: SegmentedBlock[] = [];
  let droppedHeaders = 0, mergedChapters = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isHeading = b.hint === 'heading' || b.hint === 'subheading';
    if (isHeading && b.text.length <= 120) {
      const key = furnitureKey(b.text);
      const pageNumbered = /^\d+\s+\S|\S\s+\d+$/.test(b.text) && isAllCaps(b.text.replace(/\d+/g, ''));
      if (furnitureRaw.has(b.text) || (key && furnitureKeys.has(key) && pageNumbered)) { droppedHeaders++; continue; }
    }
    const next = blocks[i + 1];
    if (isHeading && /^(chapter|part)\s+[\dIVXLC]+\.?$/i.test(b.text) && next && next.page === b.page
        && (next.hint === 'heading' || next.hint === 'subheading') && headingDepthFromNumbering(next.text) == null) {
      blocks[i + 1] = {
        ...next, hint: 'heading',
        signals: { ...next.signals, headingDepth: 1, fontSizeRatio: RATIO_BY_DEPTH[1] },
      };
      mergedChapters++;
      continue;
    }
    kept.push(b);
  }
  return { kept, droppedHeaders, mergedChapters };
}

export interface DoclingSegmentation {
  blocks: SegmentedBlock[];
  pageCount: number;
  diagnostics: LayoutDiagnostics;
  runningHeaderSections: SectionNode[];
}

export function doclingToSegmentation(doc: DoclingDocument): DoclingSegmentation {
  assertSupportedDoclingDocument(doc);
  const pageSize = (p: number) => doc.pages?.[String(p)]?.size;
  const blocks: SegmentedBlock[] = [];
  const visited = new Set<string>();
  let furniture = 0;
  const furnitureKeys = new Set<string>();
  const furnitureRaw = new Set<string>();
  let headings = 0, formulas = 0, bodies = 0, unknown = 0;
  const pagesWithText = new Set<number>();

  const resolve = (ref: string): DoclingNode | undefined => {
    const m = ref.match(/^#\/(texts|groups|tables|pictures)\/(\d+)$/);
    if (!m) return undefined;
    const list = doc[m[1] as 'texts' | 'groups' | 'tables' | 'pictures'] as DoclingNode[] | undefined;
    return list?.[Number(m[2])];
  };

  const push = (text: string, prov: DoclingProv | undefined, hint: BlockHint, depth: number | null, conf: 0 | 1 | 2) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || !prov) return;
    const size = pageSize(prov.page_no);
    const bbox = prov.bbox;
    let pageTopRatio: number | undefined;
    if (bbox && size?.height) {
      const top = bbox.coord_origin === 'TOPLEFT' ? size.height - bbox.t : bbox.t;
      pageTopRatio = +(top / size.height).toFixed(3);
    }
    const isHeading = hint === 'heading' || hint === 'subheading';
    blocks.push({
      text: clean,
      page: prov.page_no,
      readingOrder: blocks.length,
      hint,
      hintConfidence: conf,
      signals: {
        fontSizeRatio: isHeading ? RATIO_BY_DEPTH[Math.min(depth ?? 2, 4)] : 1,
        yGapAbove: 0,
        xColumnIndex: 0,
        isIsolatedLine: isHeading,
        isAllCaps: isAllCaps(clean),
        isBold: isHeading,
        lineCount: Math.max(1, Math.ceil(clean.length / 90)),
        blockWidth: bbox ? +(bbox.r - bbox.l).toFixed(1) : undefined,
        pageTopRatio,
        headingDepth: isHeading ? depth ?? undefined : undefined,
        headingConfidence: isHeading ? 1 : 0,
        dominantFont: 'docling',
      },
    });
    pagesWithText.add(prov.page_no);
    if (isHeading) headings++;
    else if (hint === 'formula') formulas++;
    else if (hint === 'unknown') unknown++;
    else bodies++;
  };

  const visit = (node: DoclingNode | undefined): void => {
    if (!node || visited.has(node.self_ref)) return;
    visited.add(node.self_ref);
    if (node.content_layer && node.content_layer !== 'body') {
      furniture++;
      const t = (node as DoclingText).text;
      if (t) { furnitureKeys.add(furnitureKey(t)); furnitureRaw.add(t.trim()); }
      return;
    }

    if (node.self_ref.startsWith('#/texts/')) {
      const t = node as DoclingText;
      const prov = t.prov?.[0];
      const text = t.text || t.orig || '';
      switch (t.label) {
        case 'title': push(text, prov, 'heading', 1, 2); break;
        case 'section_header': {
          const depth = headingDepthFromNumbering(text) ?? 2;
          push(text, prov, depth <= 1 ? 'heading' : 'subheading', depth, 2);
          break;
        }
        case 'formula': push(text, prov, 'formula', null, 2); break;
        case 'list_item': push(text, prov, 'list_item', null, 2); break;
        case 'caption': push(text, prov, 'caption', null, 2); break;
        case 'footnote': push(text, prov, 'footnote', null, 2); break;
        case 'page_header': case 'page_footer': furniture++; if (text) { furnitureKeys.add(furnitureKey(text)); furnitureRaw.add(text.trim()); } break;
        case 'text': case 'paragraph': case 'reference': push(text, prov, 'body', null, 2); break;
        case 'code': push(text, prov, 'body', null, 1); break;
        default: push(text, prov, 'unknown', null, 0);
      }
    } else if (node.self_ref.startsWith('#/tables/')) {
      // Tables become one body block of "cell | cell" rows: searchable and
      // citable, without inventing structure the rest of the pipeline lacks.
      const tb = node as DoclingTable;
      const rows = (tb.data?.grid ?? []).map(r => r.map(c => (c.text ?? '').trim()).filter(Boolean).join(' | ')).filter(Boolean);
      push(rows.join('\n'), tb.prov?.[0], 'body', null, 1);
    }
    for (const c of node.children ?? []) visit(resolve(c.$ref));
  };

  for (const c of doc.body.children ?? []) visit(resolve(c.$ref));
  const { kept, droppedHeaders, mergedChapters } = cleanHeadings(blocks, furnitureKeys, furnitureRaw);
  blocks.length = 0;
  kept.forEach((b, i) => blocks.push({ ...b, readingOrder: i }));
  headings -= droppedHeaders + mergedChapters;
  furniture += droppedHeaders;

  const pageCount = Object.keys(doc.pages ?? {}).length || (blocks.length ? Math.max(...blocks.map(b => b.page)) : 0);
  const diagnostics: LayoutDiagnostics = {
    pages_with_text: pagesWithText.size,
    unknown_hint_rate: blocks.length ? +(unknown / blocks.length).toFixed(3) : 0,
    formula_block_count: formulas,
    heading_block_count: headings,
    body_block_count: bodies,
    two_column_pages: 0,
    noise_removed_count: 0,
    repeating_header_stripped: furniture,
    running_header_sections: 0,
    merged_broken_headings: mergedChapters,
    index_blocks_stripped: 0,
    avg_blocks_per_page: pageCount ? +(blocks.length / pageCount).toFixed(1) : 0,
  };
  return { blocks, pageCount, diagnostics, runningHeaderSections: [] };
}

// ─── docling-serve client ────────────────────────────────────────────────────

export interface DoclingClientOptions {
  baseUrl: string;
  // Whole-conversion deadline (CPU conversion of a long book takes minutes).
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

function unreachable(baseUrl: string, e: unknown): Error {
  const name = (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.name ?? '';
  return new Error(`Docling server at ${baseUrl} ${name === 'TimeoutError' ? 'timed out' : 'could not be reached'}. Is docling-serve running?`);
}

// Health + version, for Settings → Test connection.
export async function doclingServerInfo(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ docling: string | null; serve: string | null }> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/version`, { signal: AbortSignal.timeout(5000) });
  } catch (e) { throw unreachable(baseUrl, e); }
  if (!res.ok) throw new Error(`Docling server at ${baseUrl} answered HTTP ${res.status}.`);
  const v = (await res.json()) as Record<string, string>;
  return { docling: v.docling ?? null, serve: v['docling-serve'] ?? null };
}

// Convert one PDF through the async API (submit → poll → result), so long
// books are not cut off by the server's synchronous wait limit. OCR is off:
// the built-in parser does not OCR either, and scanned PDFs are out of scope.
export async function convertPdfWithDocling(filePath: string, opts: DoclingClientOptions): Promise<DoclingDocument> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const pollMs = opts.pollMs ?? 2000;

  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' }), path.basename(filePath));
  form.append('to_formats', 'json');
  form.append('do_ocr', 'false');
  form.append('image_export_mode', 'placeholder');

  let submit: Response;
  try {
    submit = await f(`${base}/v1/convert/file/async`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  } catch (e) { throw unreachable(base, e); }
  if (!submit.ok) throw new Error(`Docling rejected the file (HTTP ${submit.status}).`);
  const task = (await submit.json()) as { task_id?: string };
  if (!task.task_id) throw new Error('Docling did not return a task id.');

  for (;;) {
    if (Date.now() > deadline) throw new Error('Docling conversion timed out.');
    await new Promise(r => setTimeout(r, pollMs));
    let st: Response;
    try {
      st = await f(`${base}/v1/status/poll/${encodeURIComponent(task.task_id)}`, { signal: AbortSignal.timeout(30_000) });
    } catch (e) { throw unreachable(base, e); }
    if (!st.ok) throw new Error(`Docling status check failed (HTTP ${st.status}).`);
    const s = (await st.json()) as { task_status?: string; error_message?: string | null };
    if (s.task_status === 'success') break;
    if (s.task_status === 'failure') throw new Error(`Docling could not convert this file${s.error_message ? `: ${s.error_message}` : '.'}`);
  }

  let res: Response;
  try {
    res = await f(`${base}/v1/result/${encodeURIComponent(task.task_id)}`, { signal: AbortSignal.timeout(120_000) });
  } catch (e) { throw unreachable(base, e); }
  if (!res.ok) throw new Error(`Docling result fetch failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { status?: string; errors?: unknown[]; document?: { json_content?: unknown } };
  const doc = body.document?.json_content;
  if (!doc) throw new Error(`Docling returned no document (status ${body.status ?? '?'}).`);
  assertSupportedDoclingDocument(doc);
  return doc;
}
