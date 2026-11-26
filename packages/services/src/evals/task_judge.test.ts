import { describe, expect, it } from 'vitest';
import { TaskJudgeOutputSchema, buildTaskJudgePrompt, scoreTaskJudgments, type TaskJudgeOutput } from './task_judge';

const verdict = (index: number, a: boolean, u: boolean, g = false) => ({ index, answerable: a, tests_understanding: u, targets_gap: g });
const judgment = (tasks: TaskJudgeOutput['tasks'], quality = 5): TaskJudgeOutput => ({ tasks, quality, rationale: '' });

describe('buildTaskJudgePrompt', () => {
  it('numbers tasks, lists gaps, and says "none" when there are none', () => {
    const p = buildTaskJudgePrompt({
      concept: { name: 'Deadlock', definition: 'Processes each waiting on another.' },
      tasks: [{ kind: 'definition', prompt: 'Define\n deadlock.' }, { kind: 'application', prompt: 'Spot it.' }],
      gaps: ['confuses with starvation'],
    });
    expect(p).toContain('1. [definition] Define deadlock.');
    expect(p).toContain('2. [application] Spot it.');
    expect(p).toContain('- confuses with starvation');
    expect(buildTaskJudgePrompt({ concept: { name: 'X' }, tasks: [] })).toContain('LEARNER GAPS: none');
  });
});

describe('TaskJudgeOutputSchema', () => {
  it('rejects out-of-range quality', () => {
    expect(TaskJudgeOutputSchema.safeParse(judgment([], 6)).success).toBe(false);
    expect(TaskJudgeOutputSchema.safeParse(judgment([verdict(1, true, true)], 3)).success).toBe(true);
  });
});

describe('scoreTaskJudgments', () => {
  it('rates over tasks, normalizes quality, and counts gap targeting only on adaptive sets', () => {
    const m = scoreTaskJudgments([
      { id: 'a', task_count: 2, adaptive: false, judgment: judgment([verdict(1, true, true), verdict(2, true, false)], 5) },
      { id: 'b', task_count: 2, adaptive: true, judgment: judgment([verdict(1, false, true, true), verdict(2, true, true)], 1) },
      { id: 'c', task_count: 1, adaptive: true, judgment: judgment([verdict(1, true, false, false)], 3) },
      { id: 'd', task_count: 3, adaptive: false, judgment: null },
    ]);
    expect(m).toEqual({
      judged: 3, judge_failed: 1,
      judge_quality: (1 + 0 + 0.5) / 3,
      judge_answerable: 4 / 5,
      judge_understanding: 3 / 5,
      judge_gap_targeting: 1 / 2,
    });
  });

  it('cannot be inflated by skipped or out-of-range verdicts', () => {
    const m = scoreTaskJudgments([
      { id: 'a', task_count: 4, adaptive: false, judgment: judgment([verdict(1, true, true), verdict(9, true, true), verdict(1, true, true)]) },
    ]);
    expect(m.judge_answerable).toBe(1 / 4);
    expect(m.judge_gap_targeting).toBeNull();
  });

  it('returns nulls when nothing was judged', () => {
    expect(scoreTaskJudgments([])).toMatchObject({ judged: 0, judge_quality: null, judge_answerable: null });
  });
});
