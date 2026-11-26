#!/usr/bin/env node
// Retrieval eval (RAG PR 1): keyword (FTS5 BM25) vs vector vs hybrid (RRF) on
// the golden questions in golden/retrieval.jsonl. No LLM. NOT part of CI — it
// needs the pinned textbook PDF and, for vector/hybrid, a local
// OpenAI-compatible embedding server (Ollama).
//
//   pnpm eval:retrieval -- --pdf <path-to-b36-txtbook.pdf>
//   pnpm eval:retrieval -- --pdf <path> --keyword-only     # no embedding server
//   pnpm eval:retrieval -- --pdf <path> --review           # write a local labelling sheet
//   pnpm eval:retrieval -- --pdf <path> --save-baseline
//
// Env: RETRIEVAL_EVAL_PDF (instead of --pdf), EVAL_BASE_URL (default Ollama's
// 127.0.0.1:11434/v1), EVAL_EMBED_MODEL (default nomic-embed-text).
//
// Privacy: everything runs locally. Chunk vectors are cached in
// evals/.cache/ (gitignored). Results/baselines store chunk keys and metrics
// only; the --review sheet contains book text and stays in evals/results/
// (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openPinnedDoc, readGolden } from './pinned_doc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const svc = require('../packages/services/dist/index.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
function die(msg) { console.error(`[retrieval-eval] ${msg}`); process.exit(2); }

const KS = [5, 10];
const MODES = flag('keyword-only') ? ['keyword'] : ['keyword', 'vector', 'hybrid'];

// ─── inputs / index / labels ─────────────────────────────────────────────────

const { meta, cases } = readGolden(here, die);
const { db, sourceId, sha, chunks, rows, embedder, vectorError, unresolved, parser } = await openPinnedDoc({
  svc, here, tag: 'retrieval-eval', pdf: opt('pdf') ?? process.env.RETRIEVAL_EVAL_PDF, meta, cases,
  wantVectors: MODES.includes('vector'), noCache: flag('no-cache'), die, parser: opt('parser') ?? 'builtin',
});
if (vectorError) {
  console.error(`[retrieval-eval] VECTOR MODES UNAVAILABLE: ${vectorError}\n  Start a local embedding server (e.g. \`ollama pull ${embedder.model}\`) or pass --keyword-only.`);
}
const norm = (t) => t.replace(/\s+/g, ' ').trim();

// ─── run ─────────────────────────────────────────────────────────────────────

const perMode = {};
for (const mode of MODES) {
  if (mode !== 'keyword' && vectorError) { perMode[mode] = { unavailable: vectorError }; continue; }
  const results = [];
  for (const c of cases) {
    const r = await svc.retrieveChunks(db, { query: c.question, mode, k: Math.max(...KS), sourceIds: [sourceId], embedder });
    if (r.mode_used !== mode) die(`${c.id}: requested ${mode} but ran ${r.mode_used} (${r.vector_error}) — refusing to report degraded numbers as ${mode}.`);
    results.push({
      id: c.id, category: c.category, answerable: c.answerable, relevant: c.relevantKeys,
      retrieved: r.hits.map(h => h.chunk_key), top_score: r.hits[0]?.score ?? null,
      hits: r.hits.map(h => ({ key: h.chunk_key, page: h.page_start, kw: h.keyword_rank, vec: h.vector_rank, score: +h.score.toFixed(4) })),
    });
  }
  perMode[mode] = { results, metrics: Object.fromEntries(KS.map(k => [k, svc.scoreRetrieval(results, k)])) };
}

// ─── report ──────────────────────────────────────────────────────────────────

const f = (x) => (x == null ? '  –  ' : x.toFixed(3));
const statusCounts = cases.reduce((m, c) => ((m[c.label_status] = (m[c.label_status] ?? 0) + 1), m), {});
console.log(`\n[retrieval-eval] ${cases.length} questions (${cases.filter(c => c.answerable).length} answerable) · labels: ${JSON.stringify(statusCounts)}${unresolved ? ` · ${unresolved} UNRESOLVED` : ''}`);
if (!statusCounts.reviewed) console.log('[retrieval-eval] NOTE: no human-reviewed labels yet — treat these numbers as provisional.');
console.log('\nmode      P@5    R@5    MRR@5  Cov@5  │ P@10   R@10   MRR@10 Cov@10');
for (const mode of MODES) {
  const pm = perMode[mode];
  if (pm.unavailable) { console.log(`${mode.padEnd(9)} unavailable: ${pm.unavailable}`); continue; }
  const [a, b] = [pm.metrics[5], pm.metrics[10]];
  console.log(`${mode.padEnd(9)} ${f(a.precision_at_k)}  ${f(a.recall_at_k)}  ${f(a.mrr)}  ${f(a.coverage)}  │ ${f(b.precision_at_k)}  ${f(b.recall_at_k)}  ${f(b.mrr)}  ${f(b.coverage)}`);
}
const cats = [...new Set(cases.filter(c => c.answerable).map(c => c.category))];
console.log('\nRecall@5 / MRR@5 by category');
console.log('category        n  ' + MODES.map(m => m.padEnd(14)).join(''));
for (const cat of cats) {
  const n = cases.filter(c => c.answerable && c.category === cat).length;
  const cells = MODES.map(m => {
    const g = perMode[m].metrics?.[5].by_category[cat];
    return (g ? `${f(g.recall_at_k)}/${f(g.mrr)}` : 'n/a').padEnd(14);
  });
  console.log(`${cat.padEnd(15)} ${String(n).padStart(2)}  ${cells.join('')}`);
}
if (perMode.vector?.metrics) {
  const m = perMode.vector.metrics[5];
  console.log(`\nTop-1 cosine (vector): answerable mean ${f(m.mean_top_score_answerable)} vs unanswerable mean ${f(m.mean_top_score_unanswerable)} — abstention signal for PR 2, not a threshold.`);
}

// ─── persist ─────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.mkdirSync(path.join(here, 'baselines'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const config = {
  document_sha256: sha, parser, chunker_version: svc.CHUNKER_VERSION, layout_version: svc.LAYOUT_VERSION,
  chunks: chunks.length, embed_model: embedder?.model ?? null, rrf_k: 60, candidate_pool: 50,
};
const out = { at: new Date().toISOString(), config, label_status: statusCounts, unresolved, modes: perMode };
const resFile = path.join(here, 'results', `${stamp}-retrieval.json`);
fs.writeFileSync(resFile, JSON.stringify(out, null, 2));
console.log(`\n[retrieval-eval] results → ${path.relative(process.cwd(), resFile)}`);

const flat = {};
for (const mode of MODES) {
  const pm = perMode[mode];
  if (!pm.metrics) continue;
  for (const k of KS) for (const key of ['precision_at_k', 'recall_at_k', 'mrr', 'coverage']) flat[`${mode}.${key}@${k}`] = pm.metrics[k][key];
}
const baseFile = path.join(here, 'baselines', 'retrieval.json');
if (parser !== 'builtin') {
  console.log(`[eval] parser ${parser}: not compared with or saved as the built-in baseline.`);
} else if (flag('save-baseline')) {
  const metrics = Object.fromEntries(MODES.filter(m => perMode[m].metrics).map(m => [m, perMode[m].metrics]));
  fs.writeFileSync(baseFile, JSON.stringify({ at: out.at, config, label_status: statusCounts, flat, metrics }, null, 2) + '\n');
  console.log(`[retrieval-eval] baseline saved → ${path.relative(process.cwd(), baseFile)}`);
} else if (fs.existsSync(baseFile)) {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  const regressions = svc.compareToBaseline(flat, base.flat);
  if (regressions.length) {
    console.log(`[retrieval-eval] REGRESSIONS vs baseline (${base.at}):`);
    for (const r of regressions) console.log(`    ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)}`);
    process.exitCode = 1;
  } else {
    console.log(`[retrieval-eval] no regressions vs baseline (${base.at})`);
  }
}

// ─── review sheet (local only: contains book text) ───────────────────────────

if (flag('review')) {
  const chunkByKey = new Map(rows.map(c => [c.chunk_key, c]));
  const lines = [
    `# Retrieval labelling sheet — ${meta.document.filename}`, '',
    'For each question, tick every chunk that would help answer it (or refute a false premise).',
    'Then copy the ticked keys into `relevant` in `evals/golden/retrieval.jsonl` (with page + anchor',
    'from this sheet) and set `label_status` to `reviewed`. Pool = top-10 of every mode; `★` = currently labelled.',
    'This file contains book text — it is gitignored; do not commit it.', '',
  ];
  for (const c of cases) {
    lines.push(`## ${c.id} · ${c.category} · ${c.label_status}`, '', `**${c.question}**`, '');
    const pool = new Map();   // chunk key -> { mode: 1-based rank }
    for (const mode of MODES) {
      const retrieved = perMode[mode].results?.find(r => r.id === c.id)?.retrieved ?? [];
      retrieved.forEach((key, i) => {
        if (!pool.has(key)) pool.set(key, {});
        pool.get(key)[mode] = i + 1;
      });
    }
    for (const k of c.relevantKeys) if (!pool.has(k)) pool.set(k, {});
    for (const [key, ranks] of pool) {
      const ch = chunkByKey.get(key);
      if (!ch) continue;
      const mark = c.relevantKeys.includes(key) ? '★' : ' ';
      const rk = MODES.map(m => `${m[0]}${ranks[m] ?? '-'}`).join(' ');
      lines.push(`- [${mark === '★' ? 'x' : ' '}] ${mark} \`${key}\` p${ch.page_start}${ch.page_end !== ch.page_start ? `–${ch.page_end}` : ''} (${rk}) · ${ch.section_text}`);
      lines.push(`  > ${ch.text.replace(/\s+/g, ' ').slice(0, 420)}`);
      lines.push(`  anchor: \`${norm(ch.text).slice(0, 60)}\``);
    }
    lines.push('');
  }
  const sheet = path.join(here, 'results', `${stamp}-retrieval-review.md`);
  fs.writeFileSync(sheet, lines.join('\n'));
  console.log(`[retrieval-eval] review sheet → ${path.relative(process.cwd(), sheet)} (local only)`);
}

db.close();
