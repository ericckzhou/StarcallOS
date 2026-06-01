# Contract: `enrich`

- **Contract version:** 1.0.0 (see `CONTRACT_VERSION`)
- **Pass name:** `enrich` (heavy)
- **Implemented in:** `packages/services/src/ingestion/enrichment.ts`
- **Runs in:** `candidate_gated` and `full` extraction modes only. Never in the
  default `deterministic` path.

## Purpose

Act as the **semantic interpreter** on top of deterministic geometry. The
segmenter has already split the source into ordered blocks with layout hints;
this pass labels each block's role and extracts its claim/assumptions/quote. The
LLM interprets blocks — it does **not** decide what the blocks are.

## Inputs

- A batch of pre-segmented blocks, each serialized as
  `[BLOCK <idx>] hint=<hint>(<confidence>) prior=<prior> p<page>\n<text>`.
- `idx` is a stable global index assigned by the segmenter (geometry owns it).
- Optional section paths derived from geometry headings (no LLM cost).

## Output JSON schema

```json
{
  "enriched": [
    {
      "idx": 0,
      "block_type": "definition|mechanism|example|claim|...",
      "claim": "one-sentence core assertion, or null",
      "assumptions": ["..."],
      "example_quote": "verbatim span copied from the block, or null"
    }
  ]
}
```

One entry per input block, keyed by the input `idx`.

## Hard invariants

1. **Never change block boundaries.** Return exactly one entry per input block,
   under the same `idx`. Do not split, merge, or re-segment.
2. **Never alter reading order.** Do not reorder blocks; `idx` is authoritative.
3. **Ground claims in the source.** `claim`, `assumptions`, and `example_quote`
   must be supported by *that block's* text. `example_quote` must be a verbatim
   substring of the block, not a paraphrase.
4. **Respect the geometry hint** as a prior; only override `block_type` when the
   text clearly contradicts it.

## Forbidden behavior

- Inventing blocks, indices, or content not present in the input.
- Paraphrasing into `example_quote` (it must be copyable back to the source).
- Emitting concepts, edges, tasks, or constellations — those are downstream
  passes, not this one.
- Cross-block synthesis (a block's enrichment must stand on that block alone).

## Failure behavior

- On unparseable model output, fall back to `{ "enriched": [] }` for the batch
  and continue; the deterministic candidate path is unaffected.
- An entry with a missing/invalid `block_type` is dropped, not guessed.
- A batch failure must not abort the run or discard other batches.

## Example

Input block:

```
[BLOCK 12] hint=definition(strong) prior=definition p7
A martingale is a stochastic process whose conditional expected next value,
given all past values, equals its current value.
```

Output entry:

```json
{
  "idx": 12,
  "block_type": "definition",
  "claim": "A martingale's expected next value given the past equals its current value.",
  "assumptions": ["a filtration / history is defined", "conditional expectation exists"],
  "example_quote": "conditional expected next value, given all past values, equals its current value"
}
```
