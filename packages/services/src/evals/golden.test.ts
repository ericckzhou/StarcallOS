// Offline guard for the eval harness (which is not run in CI): golden files
// must parse and use valid labels, the runner may only call functions the
// services package actually exports, and a perfect "oracle" prediction must
// score perfectly (catches label/scorer disagreements).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as svc from '../index';
import { SCORE_LABELS, scoreGrader, scoreTasks, scoreTopicFilter } from './metrics';

const EVALS = path.resolve(__dirname, '../../../../evals');
const KINDS = ['definition', 'connection', 'application', 'misconception_resistance', 'compression'];
const STATUSES = ['proposed', 'claude-reviewed', 'reviewed'];

function readJsonl(name: string): Array<Record<string, any>> {
  return fs.readFileSync(path.join(EVALS, 'golden', name), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//'))
    .map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`${name}:${i + 1}: ${(e as Error).message}`); }
    });
}

describe('evals/run.mjs contract', () => {
  it('only calls functions the services package exports', () => {
    const src = fs.readFileSync(path.join(EVALS, 'run.mjs'), 'utf8');
    const used = [...new Set([...src.matchAll(/svc\.(\w+)/g)].map(m => m[1]))];
    expect(used.length).toBeGreaterThan(10);
    const missing = used.filter(n => !(n in svc));
    expect(missing).toEqual([]);
  });
});

describe('golden sets', () => {
  it('grader cases have valid inputs and labels, and an oracle scores 1.0', () => {
    const rows = readJsonl('grader.jsonl');
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(STATUSES, r.id).toContain(r.label_status);
      expect(SCORE_LABELS, r.id).toContain(r.expected.score);
      expect(Number.isInteger(r.expected.stage) && r.expected.stage >= 0 && r.expected.stage <= 5, r.id).toBe(true);
      expect(KINDS, r.id).toContain(r.input.task_kind);
      for (const f of ['concept_name', 'concept_definition', 'task_prompt', 'user_response']) {
        expect(typeof r.input[f] === 'string' && r.input[f].length > 0, `${r.id}.${f}`).toBe(true);
      }
      if ('expects_unsupported' in r.expected) expect(typeof r.input.source_context, r.id).toBe('string');
    }
    const m = scoreGrader(rows.map(r => ({
      id: r.id, expected: r.expected,
      actual: { score: r.expected.score, stage: r.expected.stage, unsupported_count: r.expected.expects_unsupported ? 1 : 0 },
    })));
    expect(m).toMatchObject({ score_accuracy: 1, stage_exact: 1, failed: 0 });
  });

  it('lazy-task cases are well-formed and an oracle covers every expected kind', () => {
    const rows = readJsonl('lazy_tasks.jsonl');
    for (const r of rows) {
      expect(STATUSES, r.id).toContain(r.label_status);
      expect(typeof r.concept?.name, r.id).toBe('string');
      for (const k of r.expected_kinds ?? []) expect(KINDS, r.id).toContain(k);
      for (const h of r.history ?? []) {
        expect(SCORE_LABELS, r.id).toContain(h.score);
        expect(Number.isInteger(h.stage), r.id).toBe(true);
      }
    }
    const m = scoreTasks(rows.map(r => ({ id: r.id, expected_kinds: r.expected_kinds, tasks: KINDS.map(kind => ({ kind, prompt: `${kind} ${r.id}` })) })));
    expect(m.kind_coverage).toBe(1);
  });

  it('topic-filter sets have boolean labels and an oracle scores 1.0', () => {
    const rows = readJsonl('topic_filter.jsonl');
    for (const r of rows) {
      expect(STATUSES, r.id).toContain(r.label_status);
      expect(Object.values(r.labels).every(v => typeof v === 'boolean'), r.id).toBe(true);
    }
    const m = scoreTopicFilter(rows.map(r => ({
      id: r.id, labels: r.labels, kept: Object.entries(r.labels).filter(([, k]) => k).map(([t]) => t),
    })));
    expect(m).toMatchObject({ accuracy: 1, f1: 1, failed: 0 });
  });
});
