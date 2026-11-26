// PDF parsing worker, run as a Node worker thread (see pdf_parser.ts).
// pdf.js segmentation of a large book can block for about a second at a time;
// running it here keeps the main process (IPC, DB, window) responsive. No DB
// access: the worker only turns a file path into layout blocks, and main does
// the rest.
//
// Why a worker thread and not an Electron utilityProcess: pdf.js decides it is
// running in Node from `process.type`, which is 'utility' in a utilityProcess,
// so it takes its browser path there and crashes on load (DOMMatrix is not
// defined). Worker threads do not get Electron's `process.type`.

import { parentPort } from 'node:worker_threads';
import { segmentPdf } from '@starcall/services';

interface ParseRequest { id: number; filePath: string }

const port = parentPort;
if (!port) throw new Error('parse_worker must run as a worker thread');

port.on('message', (req: ParseRequest) => {
  const { id, filePath } = req;
  segmentPdf(filePath).then(
    (result) => port.postMessage({ id, ok: true, result }),
    (err: unknown) => port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});
