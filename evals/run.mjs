#!/usr/bin/env node
// Offline eval harness for the LLM passes. NOT part of CI (makes live API calls).
//
//   pnpm eval                          # all passes, provider/model from env
//   pnpm eval -- --pass grader         # one pass: grader | lazy_tasks | topic_filter
//   pnpm eval -- --model claude-haiku-4-5-20251001
//   pnpm eval -- --save-baseline       # write results as the new baseline
//   pnpm eval -- --limit 5             # smoke-run the first N cases
//
// Env: EVAL_PROVIDER (groq|anthropic|local, default groq), GROQ_API_KEY /
// ANTHROPIC_API_KEY, EVAL_BASE_URL (local; default Ollama's 127.0.0.1:11434/v1). Keys are read from env only — never from the app's
// settings.json. Results: evals/results/<timestamp>-<pass>-<model>.json.
// Baselines:  evals/baselines/<pass>.json. A metric that drops more than the
// tolerance vs. its baseline is reported and the process exits 1.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const svc = require('../packages/services/dist/index.js');

// ─── args / config ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const provider = process.env.EVAL_PROVIDER ?? 'groq';
if (!['groq', 'anthropic', 'local'].includes(provider)) die(`EVAL_PROVIDER must be groq, anthropic or local, got "${provider}"`);
const apiKey = provider === 'groq' ? process.env.GROQ_API_KEY
  : provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY
  : '';
if (provider !== 'local' && !apiKey) die(`Set ${provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'} to run evals.`);
const model = opt('model') ?? svc.DEFAULT_MODELS[provider].heavy;
const config = {
  provider, apiKey, model,
  ...(provider === 'local' ? { baseUrl: process.env.EVAL_BASE_URL ?? svc.DEFAULT_LOCAL_BASE_URL } : {}),
};
const passes = opt('pass') ? [opt('pass')] : ['grader', 'lazy_tasks', 'topic_filter'];
const limit = opt('limit') ? Number(opt('limit')) : Infinity;

function die(msg) { console.error(`[eval] ${msg}`); process.exit(2); }

function readJsonl(file) {
  return fs.readFileSync(path.join(here, 'golden', file), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//'))
    .map((l, i) => { try { return JSON.parse(l); } catch (e) { die(`${file}:${i + 1} invalid JSON: ${e.message}`); } })
    .slice(0, limit);
}

// Sequential with a small pause: evals must not storm low Groq TPM tiers.
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const PACE_MS = provider === 'groq' ? 1500 : provider === 'local' ? 0 : 200;

// ─── passes ──────────────────────────────────────────────────────────────────

async function runGrader() {
  const cases = readJsonl('grader.jsonl');
  const results = [];
  for (const c of cases) {
    let actual = null, error = null;
    try {
      const g = await svc.gradeResponse(config, c.input);
      actual = { score: g.score, stage: g.compression_stage, unsupported_count: g.unsupported_claims.length };
    } catch (e) { error = e.message; }
    results.push({ id: c.id, expected: c.expected, actual, error });
    const mark = !actual ? 'ERR' : actual.score === c.expected.score ? 'ok ' : 'XX ';
    console.log(`  ${mark} ${c.id.padEnd(34)} want ${c.expected.score}/${c.expected.stage}  got ${actual ? `${actual.score}/${actual.stage}` : error}`);
    await pause(PACE_MS);
  }
  const m = svc.scoreGrader(results);
  return {
    metrics: m,
    flat: {
      score_accuracy: m.score_accuracy, stage_exact: m.stage_exact, stage_within_1: m.stage_within_1,
      stage_mae: m.stage_mae, unsupported_precision: m.unsupported.precision, unsupported_recall: m.unsupported.recall,
      failed: m.failed,
    },
    results,
  };
}

async function runLazyTasks() {
  const cases = readJsonl('lazy_tasks.jsonl');
  const db = svc.openDb(':memory:');
  const results = [];
  for (const c of cases) {
    const source = svc.createSource(db, { filename: `${c.id}.pdf`, file_path: `${c.id}.pdf`, title: c.source_title });
    const concept = svc.createConcept(db, {
      source_id: source.id, name: c.concept.name, slug: c.id, importance: c.concept.importance ?? 'core',
      definition_text: c.concept.definition ?? '', why_exists: '', what_breaks: '',
      where_reappears: [], chunk_ids: [], section_path: c.concept.section_path ?? [],
      exam_value: 0.5, misconception_risk: 0.5, centrality_score: 0.5,
    });
    // Adaptive cases: seed graded history so generation sees a LEARNER HISTORY block.
    const historyGaps = [];
    for (const h of c.history ?? []) {
      const t = svc.createTask(db, { concept_id: concept.id, kind: 'definition', prompt: h.prompt ?? 'seed', difficulty: 3 });
      svc.createEvidenceRecord(db, {
        task_id: t.id, concept_id: concept.id, user_response: h.response ?? '', score: h.score, compression_stage: h.stage,
        gaps_detected: h.gaps ?? [], misconceptions_detected: h.misconceptions ?? [], grader_reasoning: '',
        task_prompt_snapshot: h.prompt ?? 'seed', task_kind_snapshot: 'definition', confidence_before: h.confidence ?? null,
      });
      historyGaps.push(...(h.gaps ?? []));
    }
    let tasks = null, error = null;
    try {
      const gen = c.history?.length ? svc.regenerateTasksForConcept : svc.ensureTasksForConcept;
      tasks = (await gen(config, db, concept.id)).map(t => ({ kind: t.kind, prompt: t.prompt }));
    } catch (e) { error = e.message; }
    results.push({ id: c.id, expected_kinds: c.expected_kinds, history_gaps: historyGaps.length ? historyGaps : undefined, tasks, error });
    console.log(`  ${tasks ? 'ok ' : 'ERR'} ${c.id.padEnd(34)} ${tasks ? `${tasks.length} tasks: ${[...new Set(tasks.map(t => t.kind))].join(',')}` : error}`);
    await pause(PACE_MS);
  }
  const m = svc.scoreTasks(results);
  return { metrics: m, flat: { near_duplicate_rate: m.near_duplicate_rate, kind_coverage: m.kind_coverage, gap_targeting: m.gap_targeting, failed: m.failed }, results };
}

async function runTopicFilter() {
  const sets = readJsonl('topic_filter.jsonl');
  const results = [];
  for (const s of sets) {
    const terms = Object.keys(s.labels).map(t => ({ normalized: t }));
    let kept = null, error = null;
    try {
      const { content } = await svc.chatJSON(config, {
        responseFormat: 'json', temperature: 0,
        maxTokens: Math.min(1200, Math.max(220, terms.length * 12 + 120)),
        messages: [
          { role: 'system', content: 'You are a precise textbook concept filter. Return valid JSON only.' },
          { role: 'user', content: svc.buildCandidateLlmFilterPrompt(s.source_title, terms) },
        ],
      }, 'topic_filter');
      kept = svc.parseCandidateLlmFilterResponse(content).filter(d => d.keep).map(d => d.term);
    } catch (e) { error = e.message; }
    results.push({ id: s.id, labels: s.labels, kept, error });
    console.log(`  ${kept ? 'ok ' : 'ERR'} ${s.id.padEnd(34)} ${kept ? `kept ${kept.length}/${terms.length}` : error}`);
    await pause(PACE_MS);
  }
  const m = svc.scoreTopicFilter(results);
  return { metrics: m, flat: { precision: m.keep.precision, recall: m.keep.recall, f1: m.f1, accuracy: m.accuracy, failed: m.failed }, results };
}

const RUNNERS = { grader: runGrader, lazy_tasks: runLazyTasks, topic_filter: runTopicFilter };

// ─── main ────────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.mkdirSync(path.join(here, 'baselines'), { recursive: true });

let regressed = false;
for (const pass of passes) {
  const run = RUNNERS[pass];
  if (!run) die(`unknown pass "${pass}" (expected ${Object.keys(RUNNERS).join(', ')})`);
  console.log(`\n[eval] ${pass} — ${provider}/${model}`);
  const out = await run();
  const record = {
    pass, provider, model, at: new Date().toISOString(),
    contract_version: svc.CONTRACT_VERSION, flat: out.flat, metrics: out.metrics, results: out.results,
  };
  const file = path.join(here, 'results', `${stamp}-${pass}-${model.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(`[eval] ${pass} metrics:`);
  for (const [k, v] of Object.entries(out.flat)) {
    console.log(`    ${k.padEnd(24)} ${v === null ? 'n/a' : Number.isInteger(v) ? v : v.toFixed(3)}`);
  }

  const baseFile = path.join(here, 'baselines', `${pass}.json`);
  if (flag('save-baseline')) {
    fs.writeFileSync(baseFile, JSON.stringify({ provider, model, at: record.at, contract_version: record.contract_version, flat: out.flat }, null, 2));
    console.log(`[eval] baseline saved → ${path.relative(process.cwd(), baseFile)}`);
  } else if (fs.existsSync(baseFile)) {
    const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    const regressions = svc.compareToBaseline(out.flat, base.flat);
    if (base.model !== model) console.log(`[eval] note: baseline model is ${base.model}, this run is ${model}`);
    if (regressions.length) {
      regressed = true;
      console.log(`[eval] REGRESSIONS vs baseline (${base.at}):`);
      for (const r of regressions) console.log(`    ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)}`);
    } else {
      console.log('[eval] no regressions vs baseline');
    }
  } else {
    console.log('[eval] no baseline yet — rerun with --save-baseline to record one');
  }
  console.log(`[eval] results → ${path.relative(process.cwd(), file)}`);
}
process.exit(regressed ? 1 : 0);
