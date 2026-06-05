# Contract: `grader`

- **Contract version:** 1.2.0 (see `CONTRACT_VERSION`)
- **Pass name:** `grader` (heavy)
- **Implemented in:** `packages/services/src/ingestion/grader.ts`
- **Runs in:** user submits a response to a Challenge task.

## Purpose

Assess a learner's response to one evidence task against the concept and the
task, assigning a score and compression stage and always returning the gaps that
would push the answer to the next stage. When source material is provided, the
grader **additionally** judges how well the answer is *backed by that source*
(grounding) and flags claims the source does not support. The grader is the
**resolver** of both the "no-evidence = no-claim" and the "source-grounded over
plausible" promises, so it must stay strict and predictable.

## Inputs

```ts
{
  concept_name: string,
  concept_definition: string,
  task_kind: "definition"|"connection"|"application"|"misconception_resistance"|"compression",
  task_prompt: string,
  user_response: string,
  source_context?: string,   // assembled by buildGroundingContext; when present
                             // & non-empty, grounding is assessed. When absent,
                             // grounding is skipped (see invariant 5).
}
```

## Output JSON schema

```json
{
  "score": "understood"|"recognizes"|"gap"|"misconception",
  "compression_stage": 0,
  "gaps_detected": ["..."],
  "misconceptions_detected": ["..."],
  "grounding_score": 0.0,
  "unsupported_claims": [
    { "claim": "...", "reason": "...", "severity": "minor"|"major" }
  ],
  "reasoning": "brief explanation"
}
```

Compression stages: `0` unseen · `1` memorized · `2` can explain · `3` can
connect · `4` can compress · `5` can predict failures.

`grounding_score` is `0.0`–`1.0` **or `null`** (null = grounding not assessed
because no source context was given — see invariant 5). `unsupported_claims` is
a list of structured objects (empty when grounding was not assessed or the
answer was fully supported); `severity` is `"major"` for a load-bearing claim
the source contradicts/never makes, `"minor"` for a peripheral aside.

## Hard invariants

1. **Grade only the submitted answer** against the given task + concept context.
   Do not grade what the learner "probably knows."
2. **`gaps_detected` is NEVER empty** — even on a full `understood` / stage-5
   score. It is the "what would push this further" list, not just "what's
   wrong." Each gap is one concrete, actionable sentence (not "could be more
   detailed").
3. **Never award mastery for vague recognition.** Restating the definition
   verbatim is stage 1, not stage 2. `understood` requires stage 3+.
4. **Score and stage must agree** with the rubric (`understood` ⇒ 3+;
   `recognizes` ⇒ 1–2; `gap` ⇒ partial; `misconception` ⇒ a factually wrong
   belief).
5. **Grounding is assessed ONLY when `source_context` is provided.** When it is
   absent/empty, `grounding_score` is `null` and `unsupported_claims` is `[]` —
   a sparse concept is never scored as "ungrounded" just because there was
   nothing to ground against. Absence of context is not evidence of
   hallucination. The implementation enforces this gate regardless of what the
   model returns (`parseGradeResult(raw, hasContext)`).
6. **Grounding judges support, not plausibility.** `grounding_score` measures
   whether the answer's claims trace to `source_context`; an answer can be fully
   grounded (empty `unsupported_claims`) and still have gaps, and a fluent answer
   that imports outside facts must be flagged.

## Forbidden behavior

- Inflating the score to be encouraging.
- Returning an empty `gaps_detected`.
- Inventing misconceptions the response does not contain (use
  `misconceptions_detected` only for beliefs actually present).
- Grading against general world knowledge instead of the source's framing.
- Emitting a non-null `grounding_score` or any `unsupported_claims` when no
  `source_context` was provided.
- Listing a claim as unsupported when the source context does support it.

## Failure behavior

- On unparseable output, default to the conservative shape: `score: "gap"`,
  `compression_stage: 0`, empty detail arrays, empty reasoning, `grounding_score`
  null, empty `unsupported_claims`. Never default to `understood`.
- A grade is one append-only evidence record; it never mutates prior records.
  (Downstream, deleting a record re-awards XP and recomputes mastery — the
  grounding fields are intrinsic to the attempt and need no recompute. The
  grader itself stays pure.)

## Example

Input: concept "Idempotency", task_kind `application`, response: *"If I send the
same PUT twice the resource ends in the same state, so retries are safe. HTTP
guarantees PUT is always cached at the edge."* — with a `source_context` block
defining idempotency and PUT semantics but saying nothing about edge caching.

Output:

```json
{
  "score": "understood",
  "compression_stage": 3,
  "gaps_detected": [
    "did not distinguish idempotency from safety (a safe method has no side effects at all)",
    "did not mention that POST is typically non-idempotent and why retry semantics differ there"
  ],
  "misconceptions_detected": [],
  "grounding_score": 0.6,
  "unsupported_claims": [
    {
      "claim": "HTTP guarantees PUT is always cached at the edge",
      "reason": "the source context never states edge-caching behavior for PUT; this is an imported outside claim",
      "severity": "major"
    }
  ],
  "reasoning": "Correctly applies idempotency to PUT retries and connects to retry safety (stage 3); but asserts an edge-caching guarantee the source does not support, lowering grounding."
}
```
