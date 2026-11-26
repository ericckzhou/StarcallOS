import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('../core/llm')>()), chatJSON: vi.fn() }));

import { chatJSON, type ProviderConfig, type UsageStats } from '../core/llm';
import { openDb } from '../core/infra/db';
import { createSource } from '../knowledge/repos/sources';
import { createConcept } from '../knowledge/repos/concepts';
import { createTask, listTasksByConcept, createEvidenceRecord, listRecordsByConcept } from '../knowledge/repos/evidence';
import { ensureTasksForConcept, regenerateTasksForConcept, buildLearnerHistoryBlock } from './lazy_tasks';
import type { EvidenceKind } from '../core/domain/types';

const mockChat = vi.mocked(chatJSON);
const config: ProviderConfig = { provider: 'groq', apiKey: 'k', model: 'm' };

const usage: UsageStats = {
  pass: 'lazy_tasks', provider: 'groq', model: 'm',
  promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, retries: 0, cacheReadTokens: 0,
};

function reply(tasks: Array<{ kind: string; prompt: string; difficulty: number }>) {
  return { content: JSON.stringify({ tasks }), usage };
}

function db() {
  return openDb(':memory:');
}

function mkConcept(database: ReturnType<typeof openDb>, name = 'Backpropagation'): number {
  const sourceId = createSource(database, { filename: 'b.pdf', file_path: 'b.pdf' }).id;
  return createConcept(database, {
    source_id: sourceId,
    name,
    slug: name.toLowerCase().replace(/\W+/g, '-'),
    importance: 'core',
    definition_text: 'a definition',
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0,
    misconception_risk: 0,
    centrality_score: 0.5,
  }).id;
}

const FIVE_KINDS: EvidenceKind[] = [
  'definition', 'connection', 'application', 'misconception_resistance', 'compression',
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureTasksForConcept', () => {
  it('returns existing tasks without calling the LLM (pay-per-use guard)', async () => {
    const d = db();
    const cid = mkConcept(d);
    createTask(d, { concept_id: cid, kind: 'definition', prompt: 'old', difficulty: 3 });

    const res = await ensureTasksForConcept(config, d, cid);

    expect(res).toHaveLength(1);
    expect(mockChat).not.toHaveBeenCalled();
    d.close();
  });

  it('generates and persists valid tasks, calling chatJSON with the lazy_tasks pass', async () => {
    const d = db();
    const cid = mkConcept(d);
    mockChat.mockResolvedValue(reply(FIVE_KINDS.map(k => ({ kind: k, prompt: `q-${k}`, difficulty: 3 }))));

    const res = await ensureTasksForConcept(config, d, cid);

    expect(res).toHaveLength(5);
    expect(listTasksByConcept(d, cid)).toHaveLength(5);
    expect(mockChat).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ responseFormat: 'json' }),
      'lazy_tasks',
    );
    d.close();
  });

  it('drops tasks with invalid kinds or missing prompt/kind', async () => {
    const d = db();
    const cid = mkConcept(d);
    mockChat.mockResolvedValue(reply([
      { kind: 'definition', prompt: 'good', difficulty: 3 },
      { kind: 'not_a_kind', prompt: 'bad kind', difficulty: 3 },
      { kind: 'connection', prompt: '', difficulty: 3 },
      { kind: '', prompt: 'no kind', difficulty: 3 },
    ]));

    const res = await ensureTasksForConcept(config, d, cid);

    expect(res.map(t => t.kind)).toEqual(['definition']);
    d.close();
  });

  it('clamps difficulty into the 1–5 range', async () => {
    const d = db();
    const cid = mkConcept(d);
    mockChat.mockResolvedValue(reply([
      { kind: 'definition', prompt: 'a', difficulty: 9 },
      { kind: 'connection', prompt: 'b', difficulty: 0 },
    ]));

    await ensureTasksForConcept(config, d, cid);

    const tasks = listTasksByConcept(d, cid);
    expect(tasks.find(t => t.kind === 'definition')?.difficulty).toBe(5); // 9 → 5
    expect(tasks.find(t => t.kind === 'connection')?.difficulty).toBe(3); // 0 → default 3
    d.close();
  });

  it('filters out tasks that exactly match an excluded prompt and emits an AVOID list', async () => {
    const d = db();
    const cid = mkConcept(d);
    mockChat.mockResolvedValue(reply([
      { kind: 'definition', prompt: 'Define X please', difficulty: 3 },
      { kind: 'connection', prompt: 'fresh one', difficulty: 3 },
    ]));

    const res = await ensureTasksForConcept(config, d, cid, { excludePrompts: ['  define x PLEASE  '] });

    expect(res.map(t => t.prompt)).toEqual(['fresh one']);
    const userMsg = mockChat.mock.calls[0][1].messages[1].content;
    expect(userMsg).toContain('AVOID');
    d.close();
  });

  it('throws when the concept does not exist', async () => {
    const d = db();
    await expect(ensureTasksForConcept(config, d, 9999)).rejects.toThrow(/not found/);
    d.close();
  });
});

describe('regenerateTasksForConcept', () => {
  it('deletes prior tasks and regenerates with a twist that avoids the old prompts', async () => {
    const d = db();
    const cid = mkConcept(d);
    createTask(d, { concept_id: cid, kind: 'definition', prompt: 'the old prompt', difficulty: 3 });
    mockChat.mockResolvedValue(reply([{ kind: 'definition', prompt: 'a brand new angle', difficulty: 4 }]));

    const res = await regenerateTasksForConcept(config, d, cid);

    expect(res.map(t => t.prompt)).toEqual(['a brand new angle']);
    const req = mockChat.mock.calls[0][1];
    expect(req.temperature).toBe(0.6);
    expect(req.messages[1].content).toContain('TWIST');
    expect(req.messages[1].content).toContain('the old prompt');
    d.close();
  });
});

describe('adaptive history (contract 1.4.0)', () => {
  const rec = (over: Record<string, unknown>) => ({
    score: 'recognizes' as const, compression_stage: 2 as const, gaps_detected: [] as string[],
    misconceptions_detected: [] as string[], created_at: '2026-05-01 10:00:00', calibration_gap: null as number | null, ...over,
  });

  it('is empty without history', () => {
    expect(buildLearnerHistoryBlock([])).toBe('');
  });

  it('summarizes recent-first gaps, misconceptions, best stage and overconfidence', () => {
    const block = buildLearnerHistoryBlock([
      rec({ created_at: '2026-05-01 10:00:00', compression_stage: 3, score: 'understood', gaps_detected: ['old gap'], calibration_gap: 0.4 }),
      rec({ created_at: '2026-05-03 10:00:00', gaps_detected: ['Did not mention hot keys', 'old gap'], misconceptions_detected: ['Thinks load is always even'], calibration_gap: 0.3 }),
    ]);
    expect(block).toContain('Attempts: 2. Last result: recognizes, stage 2. Best stage reached: 3.');
    expect(block.indexOf('Did not mention hot keys')).toBeLessThan(block.indexOf('old gap'));
    expect(block.match(/old gap/g)).toHaveLength(1);
    expect(block).toContain('Thinks load is always even');
    expect(block).toContain('OVERCONFIDENT');
    expect(block).toContain('stage 4');
    expect(block).toContain('probe the recorded misconception');
  });

  it('is sent to the generator once the concept has graded attempts', async () => {
    const d = db();
    const cid = mkConcept(d);
    const t = createTask(d, { concept_id: cid, kind: 'definition', prompt: 'p', difficulty: 3 });
    createEvidenceRecord(d, {
      task_id: t.id, concept_id: cid, user_response: 'r', score: 'gap', compression_stage: 1,
      gaps_detected: ['Missed the chain rule'], misconceptions_detected: [], grader_reasoning: '',
      task_prompt_snapshot: 'p', task_kind_snapshot: 'definition',
    });
    mockChat.mockResolvedValueOnce(reply(FIVE_KINDS.map(kind => ({ kind, prompt: `${kind} q`, difficulty: 3 }))));
    await regenerateTasksForConcept(config, d, cid);
    const userMsg = mockChat.mock.calls[0][1].messages.find((m: { role: string }) => m.role === 'user')!.content;
    expect(userMsg).toContain('LEARNER HISTORY');
    expect(userMsg).toContain('Missed the chain rule');
  });

  it('first-time generation has no history block', async () => {
    const d = db();
    const cid = mkConcept(d);
    mockChat.mockResolvedValueOnce(reply(FIVE_KINDS.map(kind => ({ kind, prompt: `${kind} q`, difficulty: 3 }))));
    await ensureTasksForConcept(config, d, cid);
    expect(mockChat.mock.calls[0][1].messages[1].content).not.toContain('LEARNER HISTORY');
  });
});

describe('regenerate keeps graded history (migration 0035)', () => {
  it('retires attempted tasks instead of cascading their records away', async () => {
    const d = db();
    const cid = mkConcept(d);
    const attempted = createTask(d, { concept_id: cid, kind: 'definition', prompt: 'answered', difficulty: 3 });
    createTask(d, { concept_id: cid, kind: 'connection', prompt: 'never answered', difficulty: 3 });
    createEvidenceRecord(d, {
      task_id: attempted.id, concept_id: cid, user_response: 'r', score: 'recognizes', compression_stage: 2,
      gaps_detected: ['g'], misconceptions_detected: [], grader_reasoning: '',
      task_prompt_snapshot: 'answered', task_kind_snapshot: 'definition',
    });
    mockChat.mockResolvedValueOnce(reply(FIVE_KINDS.map(kind => ({ kind, prompt: `new ${kind}`, difficulty: 3 }))));

    const fresh = await regenerateTasksForConcept(config, d, cid);

    expect(fresh.map(t => t.prompt).every(p => p.startsWith('new '))).toBe(true);
    expect(listTasksByConcept(d, cid).map(t => t.prompt).sort()).toEqual(FIVE_KINDS.map(k => `new ${k}`).sort());
    expect(listRecordsByConcept(d, cid)).toHaveLength(1);
    const rows = d.prepare('SELECT prompt, retired_at FROM evidence_tasks WHERE concept_id = ? AND prompt NOT LIKE ?').all(cid, 'new %') as Array<{ prompt: string; retired_at: string | null }>;
    expect(rows).toEqual([{ prompt: 'answered', retired_at: expect.any(String) }]);
  });
});
