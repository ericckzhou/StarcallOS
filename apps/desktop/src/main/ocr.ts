// Image → text for the image importer. tesseract.js runs the OCR engine
// (WebAssembly) in a Node worker thread, so the main thread stays responsive.
// The English model ships with the app (@tesseract.js-data/eng) and is read
// from disk: OCR never touches the network. One worker is created per import
// batch and terminated afterwards (the model is ~10 MB in memory).

import path from 'path';
import { createRequire } from 'module';
import { createWorker, OEM } from 'tesseract.js';
import type { OcrParagraph } from '@starcall/services';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] as const;

export function isImagePath(p: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(p).slice(1).toLowerCase());
}

// Directory holding eng.traineddata.gz. The best_int model is tesseract.js's
// default LSTM model (accuracy close to "best", integer-quantized for speed).
function bundledLangPath(): string {
  const req = createRequire(__filename);
  const pkgDir = path.dirname(req.resolve('@tesseract.js-data/eng/package.json'));
  return path.join(pkgDir, '4.0.0_best_int');
}

// tesseract.js reports a worker that fails to load by never settling, so every
// engine step gets a deadline: a broken engine must surface as an import error,
// not an import that spins forever.
const OCR_START_TIMEOUT_MS = 60_000;
const OCR_IMAGE_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface OcrResult {
  text: string;
  // The engine's paragraph/line structure (line height drives heading detection).
  paragraphs: OcrParagraph[];
  // Mean word confidence, 0–100.
  confidence: number;
}

// OCR each image in order with one shared worker. `cachePath` must be a
// writable directory: tesseract caches the decompressed model there (its
// default is the process cwd, which is read-only inside a packaged app).
export async function ocrImages(
  imagePaths: string[],
  cachePath: string,
): Promise<Array<{ path: string; result?: OcrResult; error?: string }>> {
  let lastStatus = '';
  // LSTM recognition (the bundled best_int model is LSTM-only). Note: in Node,
  // tesseract.js 7.0.0 still loads its full engine build regardless of this
  // (see the electron-builder.yml exclusions, which depend on that).
  const worker = await withTimeout(createWorker('eng', OEM.LSTM_ONLY, {
    langPath: bundledLangPath(),
    cachePath,
    gzip: true,
    logger: (m: { status?: string }) => {
      if (m.status && m.status !== lastStatus) { lastStatus = m.status; console.log(`[OCR] ${m.status}`); }
    },
    errorHandler: (err: unknown) => console.error('[OCR] worker error:', err),
  }), OCR_START_TIMEOUT_MS, 'Starting the OCR engine');
  try {
    const out: Array<{ path: string; result?: OcrResult; error?: string }> = [];
    for (const p of imagePaths) {
      try {
        const { data } = await withTimeout(worker.recognize(p, {}, { text: true, blocks: true }), OCR_IMAGE_TIMEOUT_MS, 'OCR');
        const paragraphs: OcrParagraph[] = (data.blocks ?? []).flatMap(b => b.paragraphs.map(par => ({
          lines: par.lines.map(l => ({
            text: l.text,
            height: l.rowAttributes?.rowHeight || Math.max(0, l.bbox.y1 - l.bbox.y0),
          })),
        })));
        out.push({ path: p, result: { text: data.text ?? '', paragraphs, confidence: data.confidence ?? 0 } });
      } catch (err) {
        out.push({ path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
