import type { CompressionStage, EvidenceKind, EvidenceScore, UnsupportedClaim } from '../core/domain/types';
import { z } from 'zod';
import { hashPrompt, type ProviderConfig } from '../core/llm';
import { CONTRACT_VERSION } from '../core/version';
import { chatStructured } from '../core/structured';

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

CALIBRATION EXAMPLES (concept: opportunity cost = "the value of the next-best
alternative given up when a choice is made")
- "The value of the next-best alternative given up when a choice is made."
  → recognizes, stage 1 (verbatim restatement; no evidence of understanding).
- "Whatever you'd have done instead is what the choice really costs you; money
  already spent doesn't count." → recognizes, stage 2 (accurate, own words).
- "It's why sunk costs are irrelevant: the only costs that matter are forward-
  looking, which is the same logic as marginal analysis." → understood, stage 3
  (unprompted link to sunk cost and marginal analysis).
- "Every choice is priced in the best thing you didn't choose." → understood,
  stage 4 (minimal first-principles compression).
- "...and it breaks down when the alternatives aren't comparable — you can't
  price a friendship in hours of wages, so people misapply it." → understood,
  stage 5 (names a limit/misuse case).
- "The opportunity cost of the concert is the $50 ticket you already paid."
  → misconception (confuses sunk cost with opportunity cost), stage 1.
- "It's about opportunities and their costs in economics." → gap, stage 1
  (vague recognition; says nothing checkable). Vague recognition is NEVER
  "recognizes" — "recognizes" requires an accurate, checkable statement.
- A response that is broadly correct but asserts specifics the source context
  does not contain stays scored on correctness, AND lists those specifics in
  unsupported_claims. A response with a single load-bearing false claim is a
  misconception even if the rest is excellent.

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

// Self-consistency: when the first grade is borderline, draw this many extra
// samples at a higher temperature and aggregate (majority score, median stage).
export const SELF_CONSISTENCY_EXTRA_SAMPLES = 2;
export const SELF_CONSISTENCY_TEMPERATURE = 0.7;
// Mid-band grounding is where single samples disagree most.
export const BORDERLINE_GROUNDING_BAND: [number, number] = [0.35, 0.65];

export interface GradeOptions {
  // Re-grade borderline answers and aggregate. Off by default.
  selfConsistency?: boolean;
}

export interface GradeAudit {
  outputs: unknown[];        // validated wire output per sample
  prompt_hash: string;       // hashPrompt(GRADER_SYSTEM)
  model: string;             // "<provider>/<model>"
  contract: string;          // CONTRACT_VERSION
  samples: number;
}

export type GradeResultWithAudit = GradeResult & { audit: GradeAudit };

export const GRADER_PROMPT_HASH = hashPrompt(GRADER_SYSTEM);

// A grade is borderline when the model's own outputs are internally
// inconsistent or sit in the band where re-sampling is most likely to flip it.
export function isBorderlineGrade(g: GradeResult): boolean {
  const [lo, hi] = BORDERLINE_GROUNDING_BAND;
  if (g.grounding_score !== null && g.grounding_score >= lo && g.grounding_score <= hi) return true;
  // Score/stage disagreement per the rubric (understood ⇔ stage ≥ 3; recognizes ⇔ 1-2).
  if (g.score === 'understood' && g.compression_stage < 3) return true;
  if (g.score === 'recognizes' && (g.compression_stage < 1 || g.compression_stage > 2)) return true;
  return false;
}

// Ties break toward the more conservative score (never round a split vote up
// to mastery). Order: most → least conservative.
const CONSERVATIVE_ORDER: EvidenceScore[] = ['misconception', 'gap', 'recognizes', 'understood'];

// Aggregate several grades of the SAME answer: majority score, median stage
// (lower median on even counts), and the text fields of the sample that best
// matches that consensus. Grounding score is the median of assessed samples.
export function aggregateGrades(samples: GradeResult[]): GradeResult {
  if (samples.length === 0) throw new Error('aggregateGrades: no samples');
  if (samples.length === 1) return samples[0];

  const counts = new Map<EvidenceScore, number>();
  for (const g of samples) counts.set(g.score, (counts.get(g.score) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const score = CONSERVATIVE_ORDER.find(sc => counts.get(sc) === top)!;

  const lowerMedian = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.floor((v.length - 1) / 2)];
  };
  const stage = lowerMedian(samples.map(g => g.compression_stage)) as CompressionStage;

  const representative = samples
    .filter(g => g.score === score)
    .sort((a, b) => Math.abs(a.compression_stage - stage) - Math.abs(b.compression_stage - stage))[0];

  const grounded = samples.map(g => g.grounding_score).filter((x): x is number => x !== null);
  return {
    ...representative,
    score,
    compression_stage: stage,
    grounding_score: representative.grounding_context_used && grounded.length > 0
      ? lowerMedian(grounded)
      : representative.grounding_score,
  };
}

export async function gradeResponse(
  config: ProviderConfig,
  input: GradeInput,
  opts: GradeOptions = {},
): Promise<GradeResultWithAudit> {
  const sourceContext = input.source_context?.trim();
  const hasContext = !!sourceContext;
  // Stable per-concept prefix first (cacheable across attempts on the same
  // concept), then the per-attempt task + answer.
  const conceptBlock = [
    `Concept: ${input.concept_name}`,
    `Definition: ${input.concept_definition}`,
    hasContext
      ? `Source context (ground the answer against THIS; do not rely on outside knowledge):\n${sourceContext}`
      : null,
  ].filter(Boolean).join('\n\n');
  const attemptBlock = [
    `Task (${input.task_kind}): ${input.task_prompt}`,
    `Learner response:\n${input.user_response}`,
  ].join('\n\n');

  // Invalid/unparseable output is repaired once, then throws LlmParseError —
  // it is NEVER silently recorded as a 'gap' grade (the old JSON.parse→{}
  // fallback did exactly that, writing a fake grade into the learner's history).
  const sample = (temperature: number, pass: string) => chatStructured(
    config,
    {
      messages: [
        { role: 'system', content: GRADER_SYSTEM, cache: true },
        { role: 'user', content: conceptBlock, cache: true },
        { role: 'user', content: attemptBlock },
      ],
      temperature,
    },
    pass,
    { schema: GraderOutputSchema, name: 'record_grade', description: 'Record the assessment of the learner response.' },
  );

  const first = await sample(0.1, 'grader');
  const outputs: unknown[] = [first.data];
  const grades: GradeResult[] = [parseGradeResult(first.data, hasContext)];

  if (opts.selfConsistency && isBorderlineGrade(grades[0])) {
    // Sequential, not parallel: keeps low Groq TPM tiers from 429-storming.
    // A failed extra sample is dropped rather than failing the whole grade.
    for (let i = 0; i < SELF_CONSISTENCY_EXTRA_SAMPLES; i++) {
      try {
        const extra = await sample(SELF_CONSISTENCY_TEMPERATURE, 'grader:consistency');
        outputs.push(extra.data);
        grades.push(parseGradeResult(extra.data, hasContext));
      } catch (e) {
        console.warn(`[GRADER] self-consistency sample ${i + 1} failed: ${(e as Error).message}`);
      }
    }
  }

  return {
    ...aggregateGrades(grades),
    audit: {
      outputs,
      prompt_hash: GRADER_PROMPT_HASH,
      model: `${config.provider}/${config.model}`,
      contract: CONTRACT_VERSION,
      samples: grades.length,
    },
  };
}

// Wire shape the model must return. Required: score + compression_stage (the
// values everything downstream depends on). Everything else is lenient; the
// invariants (non-empty gaps, grounding gate) are enforced by parseGradeResult.
// Smaller models sometimes return a single string where a list is expected;
// wrap it rather than burning a repair call on a non-critical field.
const stringList = z.preprocess(
  v => (typeof v === 'string' ? (v.trim() ? [v] : []) : v),
  z.array(z.string()),
).optional().default([]);

export const GraderOutputSchema = z.object({
  score: z.enum(['understood', 'recognizes', 'gap', 'misconception']),
  compression_stage: z.coerce.number().int().min(0).max(5),
  gaps_detected: stringList,
  misconceptions_detected: stringList,
  reasoning: z.string().optional().default(''),
  grounding_score: z.number().min(0).max(1).nullable().optional(),
  unsupported_claims: z.array(z.object({
    claim: z.string(),
    reason: z.string().optional().default(''),
    severity: z.enum(['minor', 'major']).optional().default('minor'),
  })).optional().default([]),
});

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
