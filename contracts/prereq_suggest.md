# Contract: `prereq_suggest`

- **Contract version:** 1.1.0 (see `CONTRACT_VERSION`)
- **Pass name:** `prereq_suggest` (heavy)
- **Implemented in:** `packages/services/src/knowledge/prerequisite_suggestions.ts`
  (`suggestLlmPrerequisites`)
- **Runs in:** user explicitly triggers "Suggest with AI" in the DetailPane
  Prerequisites section. Lazy, pay-per-use — NOT part of the `$0` default path.

## Purpose

Propose prerequisite edges among a single source's promoted concepts from their
names + definitions, when the deterministic `requires`/`enables` relation
candidates are too sparse. The output is **suggestions only**: each is written to
`prerequisite_suggestions` with `basis = 'llm'`, `status = 'pending'`. Nothing is
written to `concept_edges` until the user accepts a suggestion — identical to the
deterministic path. This preserves the invariant that edges are user-curated and
an LLM never silently writes them.

## Inputs

A numbered list of up to `PREREQ_SUGGEST_MAX_CONCEPTS` (60) concepts for one
source: `name` + a truncated `definition_text`. Ordered by centrality so the most
connected concepts are always included when the source is large.

## Output JSON schema

```json
{ "edges": [ { "prerequisite": "<exact concept name>", "dependent": "<exact concept name>" } ] }
```

An edge means: to understand `dependent`, the learner should first understand
`prerequisite`. It is mapped to `concept_edges` orientation `from_id =
prerequisite`, `to_id = dependent`, `edge_type = 'requires'`.

## Hard invariants

1. **Suggestions only** — never write `concept_edges` directly.
2. **Resolve by exact name** to a promoted concept on the source; an edge whose
   endpoint does not resolve is dropped (counted as `skippedUnresolved`).
3. **No self-edges** — `prerequisite === dependent` is dropped.
4. **Idempotent** — `INSERT OR IGNORE` on `(from_id, to_id, edge_type)`; a pair
   that already has a real edge is skipped (`skippedExistingEdge`).
5. **Genuine dependency only** — not mere topical relatedness.

## Failure behavior

- Unparseable output → return `{ created: 0, … }`; never throw across the pass.
- Fewer than 2 concepts on the source → no-op.
