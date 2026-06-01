# Contract: `grader`

- **Contract version:** 1.0.0 (see `CONTRACT_VERSION`)
- **Pass name:** `grader` (heavy)
- **Implemented in:** `packages/services/src/ingestion/grader.ts`
- **Runs in:** user submits a response to a Challenge task.

## Purpose

Assess a learner's response to one evidence task against the concept and the
task, assigning a score and compression stage and always returning the gaps that
would push the answer to the next stage. The grader is the **resolver** of the
"no-evidence = no-claim" system, so it must stay strict and predictable.

## Inputs

```ts
{
  concept_name: string,
  concept_definition: string,
  task_kind: "definition"|"connection"|"application"|"misconception_resistance"|"compression",
  task_prompt: string,
  user_response: string,
}
```

## Output JSON schema

```json
{
  "score": "understood"|"recognizes"|"gap"|"misconception",
  "compression_stage": 0,
  "gaps_detected": ["..."],
  "misconceptions_detected": ["..."],
  "reasoning": "brief explanation"
}
```

Compression stages: `0` unseen · `1` memorized · `2` can explain · `3` can
connect · `4` can compress · `5` can predict failures.

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

## Forbidden behavior

- Inflating the score to be encouraging.
- Returning an empty `gaps_detected`.
- Inventing misconceptions the response does not contain (use
  `misconceptions_detected` only for beliefs actually present).
- Grading against general world knowledge instead of the source's framing.

## Failure behavior

- On unparseable output, default to the conservative shape: `score: "gap"`,
  `compression_stage: 0`, empty detail arrays, empty reasoning. Never default to
  `understood`.
- A grade is one append-only evidence record; it never mutates prior records.
  (Downstream, deleting a record re-awards XP and recomputes mastery — the
  grader itself stays pure.)

## Example

Input: concept "Idempotency", task_kind `application`, response: *"If I send the
same PUT twice the resource ends in the same state, so retries are safe."*

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
  "reasoning": "Correctly applies idempotency to PUT retries and connects to retry safety (stage 3); has not compressed to a first-principles statement."
}
```
