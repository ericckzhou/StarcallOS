// Main-process client for the PDF parsing worker thread (parse_worker.ts).
//
// - One long-lived worker, started lazily on the first parse and reused.
//   Requests are matched to replies by id, so concurrent parses are fine.
// - The worker has a heap cap, so a pathological PDF that exhausts memory
//   kills the worker, not the app.
// - If the worker cannot be started at all (e.g. the bundle is missing), parsing
//   falls back to running in-process, exactly as before this existed.
// - If the worker dies mid-parse, every pending request fails with an error
//   (processing reports it like any other parse failure) and the next parse
//   starts a fresh worker. It deliberately does NOT retry in-process: a PDF
//   that kills the worker would then take the whole app down with it.

import path from 'path';
import { Worker } from 'node:worker_threads';
import {
  segmentPdf, convertPdfWithDocling, doclingToSegmentation, doclingLayoutVersion, normalizeLocalBaseUrl,
  DEFAULT_DOCLING_BASE_URL, LAYOUT_VERSION,
} from '@starcall/services';

type SegmentResult = Awaited<ReturnType<typeof segmentPdf>>;
interface Pending { resolve: (r: SegmentResult) => void; reject: (e: Error) => void }

// Generous for the largest books in a real library (the KJV Bible parses well
// under this), small enough that a runaway parse cannot exhaust the machine.
const WORKER_HEAP_MB = 2048;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(reason: string): void {
  for (const p of pending.values()) p.reject(new Error(reason));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const child = new Worker(path.join(__dirname, 'parse_worker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  child.on('message', (msg: { id: number; ok: boolean; result?: SegmentResult; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok && msg.result) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'PDF parsing failed.'));
  });
  child.on('error', (e) => console.error('[PDF_PARSER] worker error:', e));
  child.on('exit', (code) => {
    if (worker === child) worker = null;
    if (pending.size) {
      console.error(`[PDF_PARSER] worker exited (code ${code}) with ${pending.size} parse(s) in flight`);
      failAll('The PDF parser stopped unexpectedly while reading this file.');
    }
  });
  // An idle worker must not keep the app alive.
  child.unref();
  worker = child;
  return child;
}

export async function segmentPdfIsolated(filePath: string): Promise<SegmentResult> {
  // Debug/benchmark escape hatch: STARCALL_PDF_PARSER=inprocess restores the
  // old main-thread parsing.
  if (process.env.STARCALL_PDF_PARSER === 'inprocess') return segmentPdf(filePath);
  let child: Worker;
  try {
    child = getWorker();
  } catch (e) {
    console.error('[PDF_PARSER] could not start the parser worker; parsing in-process', e);
    return segmentPdf(filePath);
  }
  const id = nextId++;
  return new Promise<SegmentResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.postMessage({ id, filePath });
  });
}

// Test/diagnostic hook: terminate the worker (pending parses fail).
export function stopPdfParser(): void {
  const child = worker;
  worker = null;
  failAll('The PDF parser was stopped.');
  void child?.terminate();
}

// ─── Parser choice (built-in vs the user's docling-serve) ────────────────────

export interface ConfiguredSegmentation extends SegmentResult {
  parser: 'builtin' | 'docling';
  // Layout version stamp for what actually ran (chunks + parse runs).
  layoutVersion: string;
  // Why Docling was selected but not used; null when it was used (or not selected).
  fallback: string | null;
}

export interface PdfParserSettings { pdfParser?: 'builtin' | 'docling'; doclingBaseUrl?: string }

// Docling is optional and never fails processing: any error (server down,
// timeout, unknown output format) falls back to the built-in parser and the
// reason is reported in the result, so the parse run and UI can show it.
export async function segmentPdfConfigured(filePath: string, settings: PdfParserSettings): Promise<ConfiguredSegmentation> {
  if (settings.pdfParser === 'docling') {
    const baseUrl = normalizeLocalBaseUrl(settings.doclingBaseUrl) ?? DEFAULT_DOCLING_BASE_URL;
    try {
      const t0 = Date.now();
      const doc = await convertPdfWithDocling(filePath, { baseUrl });
      const out = doclingToSegmentation(doc);
      console.log(`[PDF_PARSER] docling ${path.basename(filePath)}: ${out.pageCount} pages, ${out.blocks.length} blocks in ${Date.now() - t0}ms`);
      return { ...out, parser: 'docling', layoutVersion: doclingLayoutVersion(), fallback: null };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[PDF_PARSER] docling failed for ${path.basename(filePath)}; using the built-in parser: ${reason}`);
      const out = await segmentPdfIsolated(filePath);
      return { ...out, parser: 'builtin', layoutVersion: LAYOUT_VERSION, fallback: reason };
    }
  }
  const out = await segmentPdfIsolated(filePath);
  return { ...out, parser: 'builtin', layoutVersion: LAYOUT_VERSION, fallback: null };
}

// Layout stamp a source SHOULD have under the current settings: text sources
// always use the built-in segmenter; PDFs follow the parser choice.
export function expectedLayoutFor(settings: PdfParserSettings) {
  return (s: { file_path: string }): string =>
    settings.pdfParser === 'docling' && !s.file_path.endsWith('.txt') ? doclingLayoutVersion() : LAYOUT_VERSION;
}
