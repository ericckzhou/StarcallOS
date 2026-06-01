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

// Contract: ../../../../contracts/grader.md (CONTRACT_VERSION). Key invariants:
// grade only the submitted answer; gaps_detected is NEVER empty; never award
// mastery for vague recognition. Bump CONTRACT_VERSION if these change.
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

GAPS — ALWAYS REQUIRED, EVEN ON A FULL UNDERSTOOD SCORE
\`gaps_detected\` must NEVER be empty. It is the "what would push this further" list,
not just the "what's wrong" list. Even when the response is excellent ("understood",
stage 3+), populate 2–4 specific gaps that would lift it toward the NEXT stage:
- From stage 3 → 4: name the first-principles compression the learner did not make.
- From stage 4 → 5: name a failure mode, edge case, or limit the learner did not surface.
- From stage 5: name a sibling concept the learner could connect this to, or a
  surprising consequence they did not articulate.

Each gap should be one concrete, actionable sentence. Not "could be more detailed" —
something specific like "did not mention that consistent hashing degrades under
hot-key skew." If the response truly leaves nothing more to add, return a
single-item gaps list noting the next concept the learner should attempt instead.

Respond ONLY with JSON:
{
  "score": "understood"|"recognizes"|"gap"|"misconception",
  "compression_stage": 0-5,
  "gaps_detected": ["...", "..."],
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

  let raw: unknown;
  try { raw = JSON.parse(content || '{}'); } catch { raw = {}; }
  return parseGradeResult(raw);
}

// Exported for unit testing — parse and enforce invariants on a raw LLM payload.
export function parseGradeResult(raw: unknown): GradeResult {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<GradeResult>;
  const gaps = Array.isArray(p.gaps_detected) && p.gaps_detected.length > 0
    ? p.gaps_detected
    : ['Continue to the next concept or attempt a harder task variant.'];
  return {
    score: (p.score ?? 'gap') as EvidenceScore,
    compression_stage: (p.compression_stage ?? 0) as CompressionStage,
    gaps_detected: gaps,
    misconceptions_detected: Array.isArray(p.misconceptions_detected) ? p.misconceptions_detected : [],
    reasoning: p.reasoning ?? '',
  };
}
