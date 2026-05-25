import type { CompressionStage, EvidenceKind, EvidenceScore } from '../core/domain/types';
import { chatJSON, type ProviderConfig } from '../core/llm';

export interface GradeInput {
  concept_name: string;
  concept_definition: string;
  task_kind: EvidenceKind;
  task_prompt: string;
  user_response: string;
}

export interface GradeResult {
  score: EvidenceScore;
  compression_stage: CompressionStage;
  gaps_detected: string[];
  misconceptions_detected: string[];
  reasoning: string;
}

const GRADER_SYSTEM = `You are an expert learning assessor. Evaluate a learner's response to an evidence task.

Compression stages:
0 = unseen
1 = memorized definition (restates verbatim or near-verbatim)
2 = can explain (explains in own words, accurate)
3 = can connect (links to at least one other concept unprompted)
4 = can compress (restates as a minimal first-principles claim)
5 = can predict failures (identifies a failure mode, misuse case, or limit)

Score meanings:
- understood: response demonstrates stage 3 or higher
- recognizes: accurate but only at stage 1-2
- gap: partially correct, missing key aspects
- misconception: contains a factually wrong belief

Be strict. Restating the definition word-for-word is stage 1, not stage 2.

Respond ONLY with JSON:
{
  "score": "understood"|"recognizes"|"gap"|"misconception",
  "compression_stage": 0-5,
  "gaps_detected": ["..."],
  "misconceptions_detected": ["..."],
  "reasoning": "brief explanation"
}`;

export async function gradeResponse(
  config: ProviderConfig,
  input: GradeInput,
): Promise<GradeResult> {
  const userMessage = [
    `Concept: ${input.concept_name}`,
    `Definition: ${input.concept_definition}`,
    `Task (${input.task_kind}): ${input.task_prompt}`,
    `Learner response:\n${input.user_response}`,
  ].join('\n\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: GRADER_SYSTEM },
        { role: 'user', content: userMessage },
      ],
      responseFormat: 'json',
      temperature: 0.1,
    },
    'grader',
  );

  const parsed = JSON.parse(content || '{}') as Partial<GradeResult>;

  return {
    score: (parsed.score ?? 'gap') as EvidenceScore,
    compression_stage: (parsed.compression_stage ?? 0) as CompressionStage,
    gaps_detected: parsed.gaps_detected ?? [],
    misconceptions_detected: parsed.misconceptions_detected ?? [],
    reasoning: parsed.reasoning ?? '',
  };
}
