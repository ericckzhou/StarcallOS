# Contract: `lazy_tasks`

- **Contract version:** 1.4.0 (see `CONTRACT_VERSION`; shared counter)
- **Pass name:** `lazy_tasks` (heavy)
- **Implemented in:** `packages/services/src/ingestion/lazy_tasks.ts`
- **Runs in:** user opens Challenge for a promoted concept with no tasks yet, or
  hits Regenerate.

## Purpose

Generate exactly 5 evidence tasks for **one** concept — one per kind, in a fixed
order — grounded in the concept's own source domain, so the learner can produce
evidence of understanding rather than recall.

## Inputs

```ts
{
  concept_name: string,
  importance: "foundational"|"core"|"supporting"|"peripheral",
  concept_definition: string,
  source_context?: string,        // verbatim evidence quotes from this source
  avoid_prompts?: string[],       // on regenerate: every already-seen prompt
}
```

## Adaptive history (1.4.0)

When the concept has graded attempts, the user message ends with a
`LEARNER HISTORY` block built by `buildLearnerHistoryBlock`: attempt count,
last score/stage, best stage, up to 3 recent distinct `gaps_detected`, up to 2
`misconceptions_detected`, and a calibration verdict (mean `calibration_gap`
vs `CALIBRATION_TOLERANCE`). The model must still return exactly 5 tasks, one
per kind in order, but aims them at the listed gaps, pitches difficulty at or
above the next stage after the best one reached, probes a recorded
misconception in the misconception_resistance task, prefers checkable
questions for an overconfident learner, and never mentions the history in the
prompts. With no history the block is absent and behavior is unchanged.

## Output JSON schema

```json
{
  "tasks": [
    { "kind": "definition",                "prompt": "...", "difficulty": 3 },
    { "kind": "connection",                "prompt": "...", "difficulty": 4 },
    { "kind": "application",               "prompt": "...", "difficulty": 4 },
    { "kind": "misconception_resistance",  "prompt": "...", "difficulty": 3 },
    { "kind": "compression",               "prompt": "...", "difficulty": 4 }
  ]
}
```

Exactly 5 tasks, in the order: `definition, connection, application,
misconception_resistance, compression`.

## Hard invariants

1. **For the given concept only.** Every task is grounded in this concept's
   name, definition, and source domain/vocabulary — never the model's default
   associations for an ambiguous name.
2. **One task per kind, fixed order**, and the `kind` label must match the
   question type (see the per-kind contracts in the prompt: e.g. `definition`
   asks what it IS, never how it's used; `compression` forbids the concept name
   in the answer).
3. **Difficulty is importance-aware**: foundational 3–5, core 2–4, supporting
   1–3, peripheral 1–2.
4. **Avoid repeating answered task shapes.** On regenerate, every prompt in
   `avoid_prompts` is off-limits; produce a genuinely different angle. Exact
   normalized duplicates are post-filtered in code.
5. **Test understanding, not recall.**

## Forbidden behavior

- Fewer or more than 5 tasks, wrong order, or mismatched `kind`.
- Tasks answerable by copying the definition.
- Re-emitting a prompt from `avoid_prompts` (or a trivial reword of one).
- Drifting to a generic meaning of the concept name when the source domain
  differs (e.g. "kernel" in an OS source vs. an ML source).

## Failure behavior

- On unparseable output, generate no tasks for the concept (leave the Challenge
  empty) rather than persisting malformed/partial tasks.
- Tasks with an unknown `kind` or an empty prompt are dropped; exact repeats of
  avoided prompts are dropped; `difficulty` is clamped to 1–5 (missing → 3).
- Generation never deletes existing answered tasks except through the explicit
  Regenerate path.

## Example

See the in-prompt `Backpropagation` example in `lazy_tasks.ts` — it exists for
**format and kind discipline only**; real output must reflect the actual domain
of the concept and source (law, history, chemistry, finance, …).
