// Shared setup for evals that run against the sha-pinned retrieval document
// (golden/retrieval.meta.json): verify the PDF, index it into the cached eval
// DB, optionally embed its chunks, and re-resolve the golden labels to the
// current chunk keys. Used by retrieval.mjs and ask.mjs.
//
// Privacy: everything runs locally. The DB and chunk vectors live in
// evals/.cache/ (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readGolden(here, die) {
  const meta = JSON.parse(fs.readFileSync(path.join(here, 'golden', 'retrieval.meta.json'), 'utf8'));
  const cases = fs.readFileSync(path.join(here, 'golden', 'retrieval.jsonl'), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//'))
    .map((l, i) => { try { return JSON.parse(l); } catch (e) { die(`retrieval.jsonl:${i + 1} invalid JSON: ${e.message}`); } });
  return { meta, cases };
}

// Returns { db, sourceId, sha, chunks, rows, embedder, vectorError, unresolved }.
// Mutates each case: c.relevantKeys = current chunk keys of its labels.
export async function openPinnedDoc({ svc, here, tag, pdf, meta, cases, wantVectors, noCache, die }) {
  if (!pdf) die(`Pass --pdf <path to ${meta.document.filename}> (or set RETRIEVAL_EVAL_PDF).`);
  if (!fs.existsSync(pdf)) die(`PDF not found: ${pdf}`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex');
  if (sha !== meta.document.sha256) {
    die(`PDF sha256 ${sha.slice(0, 12)}… does not match the labelled document ${meta.document.sha256.slice(0, 12)}… (${meta.document.filename}). Labels are only valid for that exact file.`);
  }

  fs.mkdirSync(path.join(here, '.cache'), { recursive: true });
  const dbPath = noCache ? ':memory:' : path.join(here, '.cache', `retrieval-${sha.slice(0, 12)}.db`);
  const db = svc.openDb(dbPath);
  let source = db.prepare('SELECT id FROM sources WHERE file_path = ?').get(pdf);
  if (!source) source = svc.createSource(db, { filename: path.basename(pdf), file_path: pdf, title: meta.document.title });
  const sourceId = Number(source.id);

  const t0 = Date.now();
  const seg = await svc.segmentPdf(pdf);
  const { chunks, diagnostics } = svc.chunkBlocks(seg.blocks, seg.runningHeaderSections);
  const sync = svc.syncSourceChunks(db, sourceId, chunks);
  console.log(`[${tag}] ${seg.pageCount} pages → ${seg.blocks.length} blocks → ${chunks.length} chunks (avg ${diagnostics.avg_chars} chars) in ${Date.now() - t0}ms; sync ${JSON.stringify(sync)}`);
  if (svc.CHUNKER_VERSION !== meta.labelled_with.chunker_version) {
    console.log(`[${tag}] note: labels were made with chunker ${meta.labelled_with.chunker_version}; current is ${svc.CHUNKER_VERSION}. Labels are re-resolved by page + anchor.`);
  }

  let embedder = null;
  let vectorError = null;
  if (wantVectors) {
    embedder = svc.createOpenAICompatEmbedder(process.env.EVAL_BASE_URL ?? svc.DEFAULT_LOCAL_BASE_URL, process.env.EVAL_EMBED_MODEL ?? svc.DEFAULT_EMBEDDING_MODEL);
    try {
      const t1 = Date.now();
      const r = await svc.indexSourceChunkEmbeddings(db, embedder, sourceId, (done, total) => {
        process.stdout.write(`\r[${tag}] embedding chunks ${done}/${total}`);
      });
      if (r.embedded) process.stdout.write('\n');
      console.log(`[${tag}] chunk vectors (${embedder.model}): embedded ${r.embedded}, reused ${r.total - r.embedded}, ${Date.now() - t1}ms`);
    } catch (e) {
      vectorError = e.message;
    }
  }

  // Label resolution. Prefer a chunk that still STARTS with the anchor; fall
  // back to one that CONTAINS it, so a chunk-boundary shift (e.g. a layout fix
  // that drops a running header) re-resolves mechanically instead of scoring
  // as a miss. Both are lookups of the labelled passage, never a new
  // relevance call.
  const rows = svc.listSourceChunks(db, sourceId);
  const byKey = new Map(rows.map(c => [c.chunk_key, c]));
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  let unresolved = 0;
  for (const c of cases) {
    c.relevantKeys = [];
    for (const r of c.relevant) {
      if (byKey.has(r.key)) { c.relevantKeys.push(r.key); continue; }
      const near = rows.filter(x => Math.abs(x.page_start - r.page) <= 1);
      const hit = near.find(x => norm(x.text).startsWith(r.anchor)) ?? near.find(x => norm(x.text).includes(r.anchor));
      if (hit) c.relevantKeys.push(hit.chunk_key);
      else { unresolved++; console.warn(`[${tag}] ${c.id}: label ${r.key} (p${r.page}) no longer resolves — relabel needed`); }
    }
  }

  return { db, sourceId, sha, chunks, rows, embedder, vectorError, unresolved };
}
