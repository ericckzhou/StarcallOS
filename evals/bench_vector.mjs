#!/usr/bin/env node
// Vector retrieval benchmark (audit F3). Measures the CURRENT brute-force path
// — load every chunk vector for the model from SQLite, cosine against each,
// sort, top-k — at synthetic library sizes, so a decision about caching or an
// ANN index rests on numbers rather than intuition. No model or network: the
// query "embedder" returns a fixed random vector.
//
//   pnpm -C packages/services build
//   node --expose-gc evals/bench_vector.mjs                    # 1k, 10k, 50k chunks
//   node --expose-gc evals/bench_vector.mjs --sizes 1000,10000 --dim 768 --runs 7
//
// Synthetic data: 768-dim (nomic-embed-text) L2-normalized random vectors and
// ~900-character lorem chunks in ONE file-backed DB per size (in the OS temp
// dir, deleted afterwards), so SQLite reads and BLOB decoding are realistic.
// Times are medians over --runs warm runs (the first, cold run is reported
// separately; "cold" here means first query on a freshly written DB, so the OS
// page cache is still warm). Memory is what one query's loaded vectors RETAIN
// (heap + ArrayBuffers, forced GC while still referenced) — a lower bound on
// the per-query peak, not a profiler-grade number.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const svc = require('../packages/services/dist/index.js');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SIZES = opt('sizes', '1000,10000,50000').split(',').map(Number);
const DIM = Number(opt('dim', '768'));
const RUNS = Number(opt('runs', '7'));
const K = 6, POOL = 50, MODEL = 'bench-embed';
const gc = globalThis.gc ?? (() => {});
if (!globalThis.gc) console.log('[bench] run with --expose-gc for meaningful memory numbers');

// Deterministic PRNG so runs are comparable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function randVec(r) {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = r() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const WORDS = 'induction automaton grammar language regular expression invariant loop proof theorem lemma set string state transition closure recursive tree node edge formula'.split(' ');
function lorem(r, chars) { let s = ''; while (s.length < chars) s += WORDS[Math.floor(r() * WORDS.length)] + ' '; return s.trim(); }

function seed(dbPath, n) {
  const db = svc.openDb(dbPath);
  const src = svc.createSource(db, { filename: 'bench.pdf', file_path: 'bench.pdf', title: 'Bench' });
  const r = rng(n);
  const insChunk = db.prepare(`INSERT INTO rag_chunks (source_id, chunk_key, ordinal, text, heading, section_path_json, section_text,
      page_start, page_end, block_start, block_end, block_count, has_formula, char_count, text_hash, chunker_version, layout_version)
    VALUES (?, ?, ?, ?, NULL, '[]', '', ?, ?, 0, 0, 1, 0, ?, ?, 'bench', 'bench')`);
  const insVec = db.prepare(`INSERT INTO embeddings (source_id, owner_kind, owner_id, text, text_hash, model, dim, vec)
    VALUES (?, 'chunk', ?, '', ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const text = lorem(r, 900);
    const { lastInsertRowid } = insChunk.run(src.id, `k${i}`, i, text, 1 + (i >> 3), 1 + (i >> 3), text.length, `h${i}`);
    insVec.run(src.id, Number(lastInsertRowid), `h${i}`, MODEL, DIM, svc.encodeVec(randVec(r)));
  }
  db.exec('COMMIT');
  return { db, sourceId: src.id };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mb = (b) => (b / 2 ** 20).toFixed(1);

async function benchSize(n) {
  const dbPath = path.join(os.tmpdir(), `starcall-bench-${process.pid}-${n}.db`);
  const t0 = performance.now();
  const { db, sourceId } = seed(dbPath, n);
  const seedMs = performance.now() - t0;
  const q = randVec(rng(7));
  const embedder = { model: MODEL, async embed(texts) { return texts.map(() => q); } };

  // Memory first, in isolation: freed ArrayBuffer backing stores are released
  // asynchronously, so measuring inside the timing loop subtracts the previous
  // run's garbage (that produced negative deltas). Settle, load, GC while the
  // vectors are still referenced, measure.
  const settle = async () => { gc(); await new Promise(r => setTimeout(r, 300)); gc(); };
  await settle();
  const before = process.memoryUsage();
  const held = svc.loadChunkVectors(db, MODEL, [sourceId]);
  gc();
  const after = process.memoryUsage();
  const mem = {
    rss: after.rss - before.rss, heap: after.heapUsed - before.heapUsed,
    buffers: after.arrayBuffers - before.arrayBuffers, vectors: held.length,
  };
  held.length = 0;
  await settle();

  const phases = { load: [], cosine: [], sort: [], vectorSearch: [], hybrid: [] };
  let cold = null;
  for (let run = 0; run <= RUNS; run++) {
    let t = performance.now();
    const vecs = svc.loadChunkVectors(db, MODEL, [sourceId]);
    const load = performance.now() - t;
    t = performance.now();
    const scored = vecs.map(v => ({ chunkId: v.chunkId, score: svc.cosine(q, v.vec) }));
    const cosine = performance.now() - t;
    t = performance.now();
    scored.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId).slice(0, POOL);
    const sort = performance.now() - t;
    t = performance.now();
    await svc.vectorSearch(db, embedder, 'query', { sourceIds: [sourceId], limit: POOL });
    const vs = performance.now() - t;
    t = performance.now();
    await svc.retrieveChunks(db, { query: 'loop invariant proof', mode: 'hybrid', k: K, sourceIds: [sourceId], embedder });
    const hy = performance.now() - t;
    if (run === 0) { cold = { load, cosine, sort, vectorSearch: vs, hybrid: hy }; continue; }
    phases.load.push(load); phases.cosine.push(cosine); phases.sort.push(sort);
    phases.vectorSearch.push(vs); phases.hybrid.push(hy);
  }
  db.close();
  const size = fs.statSync(dbPath).size;
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const med = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, median(v)]));
  return { n, seedMs, dbMB: size / 2 ** 20, cold, med, mem };
}

console.log(`[bench] dim ${DIM} · pool ${POOL} · k ${K} · ${RUNS} warm runs · node ${process.version} · ${os.cpus()[0]?.model ?? 'cpu'}\n`);
const rows = [];
for (const n of SIZES) {
  const r = await benchSize(n);
  rows.push(r);
  const f = (x) => x.toFixed(1).padStart(8);
  console.log(`${String(n).padStart(6)} chunks  db ${r.dbMB.toFixed(0)} MB (seed ${(r.seedMs / 1000).toFixed(1)}s)`);
  console.log(`        median ms  load${f(r.med.load)}  cosine${f(r.med.cosine)}  sort${f(r.med.sort)}  vectorSearch${f(r.med.vectorSearch)}  hybrid total${f(r.med.hybrid)}`);
  console.log(`        cold   ms  load${f(r.cold.load)}  cosine${f(r.cold.cosine)}  sort${f(r.cold.sort)}  vectorSearch${f(r.cold.vectorSearch)}  hybrid total${f(r.cold.hybrid)}`);
  console.log(`        retained   ${mb(r.mem.heap + r.mem.buffers)} MB (heap ${mb(r.mem.heap)} + ArrayBuffers ${mb(r.mem.buffers)}) for ${r.mem.vectors} vectors; raw f32 ${mb(r.mem.vectors * DIM * 4)} MB; rss Δ ${mb(r.mem.rss)} MB\n`);
}
if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
