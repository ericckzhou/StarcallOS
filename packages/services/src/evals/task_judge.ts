// LLM-as-judge for generated challenge tasks (offline evals only; `pnpm eval
// -- --pass lazy_tasks --judge`). Complements the deterministic task metrics
// (near-duplicates, kind coverage, lexical gap targeting) with the judgments a
// word-overlap proxy can't make: is each task answerable from the concept,
// does it test understanding rather than recall, and does it actually target
// one of the learner's recorded gaps (paraphrase-aware).
//
// Never used by the app. The judge is a model too: treat its numbers as a
// second opinion, compare runs with the SAME judge model, and keep the
// deterministic metrics as the regression gate.

import { z } from 'zod';
import type { ProviderConfig } from '../core/llm';
import { chatStructured } from '../core/structured';

export const TaskJudgeOutputSchema = z.object({
  tasks: z.array(z.object({
    index: z.number().int().min(1),
    answerable: z.boolean(),           // answerable from the concept as given, no outside facts
    tests_understanding: z.boolean(),  // requires reasoning/application, not verbatim recall
    targets_gap: z.boolean(),          // directly works on one of the listed gaps (false when none listed)
  })),
  quality: z.number().int().min(1).max(5), // the set as a study session, 5 = excellent
  rationale: z.string(),
});
export type TaskJudgeOutput = z.infer<typeof TaskJudgeOutputSchema>;

export interface TaskJudgeInput {
  concept: { name: string; definition?: string };
  tasks: Array<{ kind: string; prompt: string }>;
  gaps?: string[];  // the learner's recorded gaps, for adaptive sets
}

export const TASK_JUDGE_SYSTEM = `You are a strict reviewer of study tasks generated for one concept.
For EACH numbered task decide:
- answerable: a learner could answer it from the concept as described (name + definition) plus general reasoning. False if it needs facts the concept does not provide.
- tests_understanding: answering requires explaining, applying, connecting or contrasting. False for "define X" / "list the parts of X" style recall.
- targets_gap: the task directly exercises one of the LEARNER GAPS listed (paraphrase counts). Always false when no gaps are listed.
Then rate the whole set 1-5 as a study session (variety, difficulty spread, no near-duplicates, faithful to the concept).
Judge only what is written. Do not reward length. Give a one-sentence rationale.

Respond with ONLY this JSON object, one entry per task in order:
{"tasks":[{"index":1,"answerable":true,"tests_understanding":true,"targets_gap":false}],"quality":4,"rationale":"..."}`;

export function buildTaskJudgePrompt(input: TaskJudgeInput): string {
  const lines = [`CONCEPT: ${input.concept.name}`];
  if (input.concept.definition?.trim()) lines.push(`DEFINITION: ${input.concept.definition.trim()}`);
  lines.push('', input.gaps?.length ? `LEARNER GAPS:\n${input.gaps.map(g => `- ${g}`).join('\n')}` : 'LEARNER GAPS: none', '', 'TASKS:');
  input.tasks.forEach((t, i) => lines.push(`${i + 1}. [${t.kind}] ${t.prompt.replace(/\s+/g, ' ').trim()}`));
  return lines.join('\n');
}

export async function judgeTaskSet(config: ProviderConfig, input: TaskJudgeInput): Promise<TaskJudgeOutput> {
  const { data } = await chatStructured(
    config,
    {
      messages: [
        { role: 'system', content: TASK_JUDGE_SYSTEM },
        { role: 'user', content: buildTaskJudgePrompt(input) },
      ],
      temperature: 0,
      maxTokens: 1024,
    },
    'task_judge',
    { schema: TaskJudgeOutputSchema, name: 'record_task_judgment' },
  );
  return data;
}

export interface TaskJudgeCaseResult {
  id: string;
  task_count: number;
  adaptive: boolean;               // the case had recorded gaps
  judgment: TaskJudgeOutput | null; // null = judge call failed
}

export interface TaskJudgeMetrics {
  judged: number;
  judge_failed: number;
  judge_quality: number | null;            // mean set quality, normalized (q-1)/4 → 0..1
  judge_answerable: number | null;         // share of tasks answerable from the concept
  judge_understanding: number | null;      // share of tasks testing understanding
  judge_gap_targeting: number | null;      // adaptive sets with ≥1 task targeting a gap
}

// Per-task verdicts are matched to tasks by `index`; verdicts for indexes the
// set doesn't have are ignored and tasks the judge skipped count as "no", so
// a judge that answers for fewer tasks can't inflate the rates.
export function scoreTaskJudgments(results: TaskJudgeCaseResult[]): TaskJudgeMetrics {
  const ok = results.filter(r => r.judgment !== null) as Array<TaskJudgeCaseResult & { judgment: TaskJudgeOutput }>;
  let tasks = 0, answerable = 0, understanding = 0, quality = 0, adaptive = 0, targeted = 0;
  for (const r of ok) {
    const byIndex = new Map(r.judgment.tasks.filter(t => t.index <= r.task_count).map(t => [t.index, t]));
    tasks += r.task_count;
    for (const t of byIndex.values()) {
      if (t.answerable) answerable++;
      if (t.tests_understanding) understanding++;
    }
    quality += (r.judgment.quality - 1) / 4;
    if (r.adaptive) {
      adaptive++;
      if ([...byIndex.values()].some(t => t.targets_gap)) targeted++;
    }
  }
  const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);
  return {
    judged: ok.length,
    judge_failed: results.length - ok.length,
    judge_quality: rate(quality, ok.length),
    judge_answerable: rate(answerable, tasks),
    judge_understanding: rate(understanding, tasks),
    judge_gap_targeting: rate(targeted, adaptive),
  };
}
