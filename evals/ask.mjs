#!/usr/bin/env node
// Ask answer eval: runs the retrieval golden questions through the real
// `askSources` pipeline (hybrid retrieval → local model → citation
// verification) and scores the answers deterministically — status mix,
// abstention on unanswerable questions, citation precision against the golden
// relevant chunks, dropped citations, latency. No LLM judge. NOT part of CI:
// it needs the pinned textbook, a local embedding server and a local model.
//
//   pnpm eval:ask -- --pdf <path-to-b36-txtbook.pdf> --model qwen3.5:4b
//   pnpm eval:ask -- --pdf <path> --model <m> --limit 5        # smoke run
//   pnpm eval:ask -- --pdf <path> --model <m> --save-baseline
//   pnpm eval:ask -- --pdf <path> --model <m> --neighbors      # A/B with neighbor expansion (opt-in)
//
// Env: RETRIEVAL_EVAL_PDF (instead of --pdf), EVAL_ASK_MODEL (instead of
// --model), EVAL_BASE_URL (default Ollama's 127.0.0.1:11434/v1, used for both
// chat and embeddings), EVAL_EMBED_MODEL (default nomic-embed-text).
//
// Privacy: local only, like Ask itself. Results (which contain answer text and
// quotes from the book) go to evals/results/ (gitignored); the baseline holds
// metrics only.

import crypto from 'node:crypto';
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
function die(msg) { console.error(`[ask-eval] ${msg}`); process.exit(2); }

// Local answers vary run to run even at temperature 0, and one question out of
// 27 moves a rate by 0.037 — so a regression needs two questions' worth.
const TOLERANCE = 0.075;
const LOWER_IS_BETTER = [
  'answerable.declined_rate', 'answerable.unsupported_rate', 'answerable.failed_rate', 'dropped_citation_rate',
];

const model = opt('model') ?? process.env.EVAL_ASK_MODEL;
if (!model) die('Pass --model <local chat model> (or set EVAL_ASK_MODEL), e.g. --model qwen3.5:4b.');
const baseUrl = process.env.EVAL_BASE_URL ?? svc.DEFAULT_LOCAL_BASE_URL;
const config = { provider: 'local', apiKey: '', model, baseUrl };
const limit = opt('limit') ? Number(opt('limit')) : Infinity;
const neighbors = flag('neighbors');

// ─── inputs / index / labels ─────────────────────────────────────────────────

const golden = readGolden(here, die, opt('golden'));
const goldenSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(here, 'golden', `${golden.set}.jsonl`))).digest('hex');
const VERIFIER = svc.ASK_VERIFICATION.version;
const cases = golden.cases.slice(0, limit);
const { db, sourceId, sha, chunks, rows, embedder, vectorError, unresolved, parser } = await openPinnedDoc({
  svc, here, tag: 'ask-eval', pdf: opt('pdf') ?? process.env.RETRIEVAL_EVAL_PDF, meta: golden.meta, cases,
  wantVectors: true, noCache: flag('no-cache'), die, parser: opt('parser') ?? 'builtin',
});
// Ask runs hybrid retrieval in the app; scoring a keyword fallback as "Ask"
// would hide a broken embedding setup.
if (vectorError) die(`embedding server unavailable (${vectorError}). Start it (e.g. \`ollama pull ${embedder.model}\`).`);
const keyById = new Map(rows.map(r => [r.id, r.chunk_key]));

// ─── run ─────────────────────────────────────────────────────────────────────

console.log(`[ask-eval] ${cases.length} questions · model ${model} @ ${baseUrl}\n`);
const results = [];
for (const c of cases) {
  const t0 = Date.now();
  const r = await svc.askSources(db, { question: c.question, sourceIds: [sourceId], config, embedder, neighbors });
  const latency_ms = Date.now() - t0;
  if (r.retrieval.mode_used !== 'hybrid') die(`${c.id}: retrieval degraded to ${r.retrieval.mode_used} (${r.retrieval.vector_error})`);
  const rel = new Set(c.relevantKeys);
  const cited = r.citations.map(x => keyById.get(x.chunk_id) ?? `?${x.chunk_id}`);
  const passages = r.passages.map(p => keyById.get(p.chunk_id) ?? `?${p.chunk_id}`);
  const row = {
    id: c.id, category: c.category, answerable: c.answerable, relevant: c.relevantKeys, expected: c.expected,
    status: r.status, cited, dropped: r.dropped.length, latency_ms,
    uncited_claims: (r.claims ?? []).filter(x => x.issue === 'uncited').length,
    low_overlap_claims: (r.claims ?? []).filter(x => x.issue === 'low_overlap').length,
    implicit_claims: (r.claims ?? []).filter(x => x.implicit).length,
    // diagnostics (not scored)
    relevant_in_context: passages.some(k => rel.has(k)),
    passages, dropped_reasons: r.dropped.map(d => d.reason),
    quotes: r.citations.map(x => ({ n: x.n, quote: x.quote })),
    flagged_claims: (r.claims ?? []).filter(x => x.issue).map(x => ({ issue: x.issue, overlap: x.overlap, cited: x.cited, text: x.text })),
    generation_error: r.generation_error, answer: r.answer,
  };
  results.push(row);
  const relCites = cited.filter(k => rel.has(k)).length;
  console.log(`  ${c.id} ${c.category.padEnd(13)} ${r.status.padEnd(14)} cites ${cited.length} (rel ${relCites}) dropped ${row.dropped} claims ${row.uncited_claims}u/${row.low_overlap_claims}o ctx ${row.relevant_in_context ? 'rel' : '---'} ${(latency_ms / 1000).toFixed(1)}s${r.generation_error ? `  ERR ${r.generation_error.slice(0, 80)}` : ''}`);
}

// ─── report ──────────────────────────────────────────────────────────────────

const m = svc.scoreAsk(results);
const f = (x) => (x == null ? '  –  ' : x.toFixed(3));
const statusCounts = cases.reduce((acc, c) => ((acc[c.label_status] = (acc[c.label_status] ?? 0) + 1), acc), {});
const a = m.answerable;
console.log(`\n[ask-eval] ${m.n} questions (${a.n} answerable, ${m.n_unanswerable} unanswerable) · labels: ${JSON.stringify(statusCounts)}${unresolved ? ` · ${unresolved} UNRESOLVED` : ''}`);
if (!statusCounts.reviewed) console.log('[ask-eval] NOTE: no human-reviewed labels yet — treat these numbers as provisional.');
console.log(`\nprimary      citations verified via explicit [n] markers ${f(m.citation_verified_explicit_rate)}  (auto-linked answers excluded; gated)`);
console.log(`answerable   citations-verified incl. auto-linked ${f(a.citation_verified_rate)} (aggregate, kept for comparability)  supported ${f(a.supported_rate)}  declined ${f(a.declined_rate)}  unsupported ${f(a.unsupported_rate)}  failed ${f(a.failed_rate)}`);
console.log(`abstention   correct on unanswerable ${f(m.correct_abstention_rate)} (n=${m.n_unanswerable})`
  + (m.n_insufficient_context ? `  · cautious on related-but-insufficient ${f(m.correct_caution_rate)} (n=${m.n_insufficient_context})` : ''));
const unlabelled = results.filter(r => r.answerable && r.relevant.length === 0 && (r.expected ?? 'answer') === 'answer');
if (unlabelled.length) console.log(`unlabelled   ${unlabelled.length} answerable case(s) without relevance labels (status shown above, excluded from answer metrics): ${unlabelled.map(r => r.id).join(', ')}`);
console.log(`citations    precision ${f(m.citation_precision)}  relevant-cited answers ${f(m.relevant_citation_rate)}  dropped ${f(m.dropped_citation_rate)}`);
console.log(`claims       answers with an uncited sentence ${f(m.uncited_claim_answer_rate)}  with a low-overlap sentence ${f(m.low_overlap_answer_rate)}  (heuristic; entailment not checked)`);
console.log(`auto-link    answers linked automatically (one unmarked sentence) ${f(m.implicit_link_answer_rate)}  (reported, not gated)`);
console.log(`latency      p50 ${(m.latency_p50_ms / 1000).toFixed(1)}s  p95 ${(m.latency_p95_ms / 1000).toFixed(1)}s`);
const declinedWithContext = results.filter(r => r.answerable && r.relevant.length && ['insufficient', 'no_passages'].includes(r.status) && r.relevant_in_context);
if (declinedWithContext.length) {
  console.log(`diagnostic   ${declinedWithContext.length} answerable question(s) declined although a relevant passage was in context: ${declinedWithContext.map(r => r.id).join(', ')}`);
}
console.log('\ncategory        n  cit-ver  supported declined unsupp  failed');
for (const [cat, g] of Object.entries(m.by_category)) {
  console.log(`${cat.padEnd(15)} ${String(g.n).padStart(2)}  ${f(g.citation_verified_rate)}    ${f(g.supported_rate)}     ${f(g.declined_rate)}    ${f(g.unsupported_rate)}  ${f(g.failed_rate)}`);
}

// ─── persist ─────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.mkdirSync(path.join(here, 'baselines'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Exact model builds, so a baseline names what produced it (a tag like
// qwen3.5:4b can be re-pulled to different weights). Ollama-only; null elsewhere.
async function modelDigest(name) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = (await res.json()).models ?? [];
    const hit = tags.find(t => t.name === name || t.model === name) ?? tags.find(t => t.name === `${name}:latest`);
    return hit?.digest ?? null;
  } catch { return null; }
}
const runConfig = {
  golden_set: golden.set, golden_sha256: goldenSha, verifier_version: VERIFIER,
  model_digest: await modelDigest(model), embed_model_digest: await modelDigest(embedder.model),
  document_sha256: sha, parser, chunker_version: svc.CHUNKER_VERSION, layout_version: svc.LAYOUT_VERSION, chunks: chunks.length,
  model, embed_model: embedder.model, k: 6, neighbors, max_passage_chars: 1600, cases: cases.length,
};
const out = { at: new Date().toISOString(), config: runConfig, label_status: statusCounts, unresolved, metrics: m, results };
const resFile = path.join(here, 'results', `${stamp}-ask-${model.replace(/[^\w.-]+/g, '_')}.json`);
fs.writeFileSync(resFile, JSON.stringify(out, null, 2));
console.log(`\n[ask-eval] results → ${path.relative(process.cwd(), resFile)} (local only: contains answer text)`);

const flat = {
  'answerable.citation_verified_rate': a.citation_verified_rate, 'answerable.supported_rate': a.supported_rate,
  'answerable.declined_rate': a.declined_rate, 'answerable.unsupported_rate': a.unsupported_rate,
  'answerable.failed_rate': a.failed_rate, correct_abstention_rate: m.correct_abstention_rate,
  citation_precision: m.citation_precision, relevant_citation_rate: m.relevant_citation_rate,
  dropped_citation_rate: m.dropped_citation_rate,
  // Gated since 2026-11-27 (confirmed on a live run, baseline amended on purpose).
  // implicit_link_answer_rate stays reported only: it has no better direction.
  citation_verified_explicit_rate: m.citation_verified_explicit_rate,
};
const baseFile = path.join(here, 'baselines', 'ask.json');
if (!golden.isDefault) {
  console.log(`[eval] golden set ${golden.set}: not compared with or saved as the baseline (reviewed set only).`);
} else if (parser !== 'builtin') {
  console.log(`[eval] parser ${parser}: not compared with or saved as the built-in baseline.`);
} else if (flag('save-baseline')) {
  if (Number.isFinite(limit)) die('refusing to save a baseline from a --limit run.');
  if (neighbors) die('refusing to save a baseline with --neighbors (not the app default).');
  // A server fault (OOM, crash, connection drop) is infrastructure, not model
  // behavior; a baseline containing one would encode a bogus failed_rate.
  // Invalid model OUTPUT is behavior and stays counted.
  const infra = results.filter(r => r.generation_error && /HTTP 5\d\d|ECONNREFUSED|fetch failed|ECONNRESET|timed? ?out/i.test(r.generation_error));
  if (infra.length) die(`refusing to save a baseline: model server errors on ${infra.map(r => r.id).join(', ')} (${infra[0].generation_error.slice(0, 120)}). Re-run.`);
  const { results: _r, ...metricsOnly } = out;
  fs.writeFileSync(baseFile, JSON.stringify({ ...metricsOnly, flat }, null, 2) + '\n');
  console.log(`[ask-eval] baseline saved → ${path.relative(process.cwd(), baseFile)}`);
} else if (fs.existsSync(baseFile) && !Number.isFinite(limit)) {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  // Different verifier = different status definitions: the numbers are not
  // comparable, and reporting "regressions" across them would be misleading.
  const baseVerifier = base.config.verifier_version ?? 1;
  if (baseVerifier !== VERIFIER) {
    console.log(`[ask-eval] baseline was recorded with citation verifier v${baseVerifier}; this run uses v${VERIFIER}. Metrics are not comparable: archive the old baseline and re-record with --save-baseline (see evals/README.md).`);
    process.exitCode = 1;
  } else {
  if (base.config.golden_sha256 && base.config.golden_sha256 !== goldenSha) console.log('[ask-eval] note: the golden set changed since the baseline was recorded.');
  if (base.config.model_digest && base.config.model_digest !== runConfig.model_digest) console.log('[ask-eval] note: the model build (digest) differs from the baseline.');
  if (base.config.model !== model) console.log(`[ask-eval] note: baseline was recorded with ${base.config.model}, this run used ${model}.`);
  const regressions = svc.compareToBaseline(flat, base.flat, TOLERANCE, LOWER_IS_BETTER);
  if (regressions.length) {
    console.log(`[ask-eval] REGRESSIONS vs baseline (${base.at}, tolerance ${TOLERANCE}):`);
    for (const r of regressions) console.log(`    ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)}`);
    process.exitCode = 1;
  } else {
    console.log(`[ask-eval] no regressions vs baseline (${base.at}, tolerance ${TOLERANCE})`);
  }
  }
}

db.close();
