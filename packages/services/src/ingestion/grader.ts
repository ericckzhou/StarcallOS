import type { CompressionStage, EvidenceKind, EvidenceScore, UnsupportedClaim } from '../core/domain/types';
import { chatJSON, type ProviderConfig } from '../core/llm';

export type { UnsupportedClaim };

export interface GradeInput {
  concept_name: string;
  concept_definition: string;
  task_kind: EvidenceKind;
  task_prompt: string;
  user_response: string;
  // Source material to ground the answer against (assembled by
  // buildGroundingContext). When present & non-empty, the grader additionally
  // scores how well the answer is BACKED BY the source and flags unsupported
  // claims. When absent/empty, grounding is skipped (grounding_score = null).
  source_context?: string;
}

export interface GradeResult {
  score: EvidenceScore;
  compression_stage: CompressionStage;
  gaps_detected: string[];
  misconceptions_detected: string[];
  reasoning: string;
  // Source-grounding signals. grounding_score is 0..1 or null (null = grounding
  // was NOT assessed because no source context was available — never read this
  // as "ungrounded"). grounding_context_used mirrors that gate explicitly.
  grounding_score: number | null;
  grounding_context_used: boolean;
  unsupported_claims: UnsupportedClaim[];
}

// Contract: ../../../../contracts/grader.md (CONTRACT_VERSION). Key invariants:
// grade only the submitted answer; gaps_detected is NEVER empty; never award
// mastery for vague recognition; assess grounding ONLY when source context is
// given. Bump CONTRACT_VERSION if these change.
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

SOURCE GROUNDING — assess ONLY when a "Source context" block is provided below
This is separate from whether the answer is correct in general. Judge whether the
answer is BACKED BY the given source, not whether it is plausible or eloquent.
- "grounding_score": a number 0.0–1.0. 1.0 = every substantive claim in the answer
  traces to the source context; 0.0 = the answer's core claims are absent from or
  contradict the source.
- "unsupported_claims": a list of specific claims the learner asserted that the
  SOURCE CONTEXT does not support — possible hallucinations or imported outside
  beliefs. Each item is an object:
    { "claim": "<the learner's claim, quoted or tightly paraphrased>",
      "reason": "<why the source does not support it>",
      "severity": "minor" | "major" }
  "major" = a load-bearing claim the source contradicts or never makes; "minor" =
  a peripheral detail or plausible aside the source does not state. An answer can
  be fully grounded (empty list) and STILL have gaps.
If NO source context block is provided, set "grounding_score": null and
"unsupported_claims": []. Never penalize the learner for context you were not given.

Respond ONLY with JSON:
{
  "score": "understood"|"recognizes"|"gap"|"misconception",
  "compression_stage": 0-5,
  "gaps_detected": ["...", "..."],
  "misconceptions_detected": ["..."],
  "grounding_score": 0.0,
  "unsupported_claims": [{ "claim": "...", "reason": "...", "severity": "minor"|"major" }],
  "reasoning": "brief explanation"
}`;

export async function gradeResponse(
  config: ProviderConfig,
  input: GradeInput,
): Promise<GradeResult> {
  const sourceContext = input.source_context?.trim();
  const hasContext = !!sourceContext;
  const userMessage = [
    `Concept: ${input.concept_name}`,
    `Definition: ${input.concept_definition}`,
    `Task (${input.task_kind}): ${input.task_prompt}`,
    `Learner response:\n${input.user_response}`,
    hasContext
      ? `Source context (ground the answer against THIS; do not rely on outside knowledge):\n${sourceContext}`
      : null,
  ].filter(Boolean).join('\n\n');

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
  return parseGradeResult(raw, hasContext);
}

function parseGroundingScore(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function parseUnsupportedClaims(raw: unknown): UnsupportedClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: UnsupportedClaim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
    if (!claim) continue;
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    const severity: 'minor' | 'major' = o.severity === 'major' ? 'major' : 'minor';
    out.push({ claim, reason, severity });
  }
  return out;
}

// Exported for unit testing — parse and enforce invariants on a raw LLM payload.
// `hasContext` says whether source context was actually given to the grader; when
// false, grounding is forced to the "not assessed" shape (null score, no claims)
// regardless of what the model returned, so a sparse concept is never scored as
// "ungrounded" off a hallucinated grounding number.
export function parseGradeResult(raw: unknown, hasContext = false): GradeResult {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<GradeResult> & Record<string, unknown>;
  const gaps = Array.isArray(p.gaps_detected) && p.gaps_detected.length > 0
    ? p.gaps_detected
    : ['Continue to the next concept or attempt a harder task variant.'];
  return {
    score: (p.score ?? 'gap') as EvidenceScore,
    compression_stage: (p.compression_stage ?? 0) as CompressionStage,
    gaps_detected: gaps,
    misconceptions_detected: Array.isArray(p.misconceptions_detected) ? p.misconceptions_detected : [],
    reasoning: p.reasoning ?? '',
    grounding_score: hasContext ? parseGroundingScore(p['grounding_score']) : null,
    grounding_context_used: hasContext,
    unsupported_claims: hasContext ? parseUnsupportedClaims(p['unsupported_claims']) : [],
  };
}
