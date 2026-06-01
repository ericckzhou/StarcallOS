# LLM Contracts

StarcallOS holds its LLM passes to explicit, versioned contracts — the same
discipline the deterministic parser already has via `PARSER_VERSION` /
`GRAMMAR_VERSION` / `LAYOUT_VERSION`. Each file here specifies one pass: its
purpose, inputs, output schema, hard invariants, forbidden behavior, failure
behavior, and an example.

These are the **source of truth for intended behavior**. The prompt builders in
`packages/services/src/**` implement them; when a prompt and its contract
disagree, the contract is the bug report.

## Versioning

`CONTRACT_VERSION` lives in
[`packages/services/src/core/version.ts`](../packages/services/src/core/version.ts)
and is stamped onto every `parse_runs` row (migration `0024`), so any extraction
can be traced to the contract the model was held to — LLM behavior becomes as
inspectable as parser behavior, and part of the evidence system rather than
stale philosophy.

Bump `CONTRACT_VERSION` when any contract's **purpose, output schema, hard
invariants, or forbidden behavior** changes — anything that makes the same input
legitimately produce a different shape or decision. Cosmetic prompt wording that
does not change the contract does not require a bump. The version is currently
shared across all passes; if passes need to diverge, split it into a per-pass
map and stamp the relevant one.

## Passes

| Contract | Pass name (`chatJSON` `passName`) | When it runs |
|---|---|---|
| [enrich.md](enrich.md) | `enrich` | `candidate_gated` / `full` extraction — semantic interpretation of pre-segmented blocks |
| [grader.md](grader.md) | `grader` | User submits a Challenge answer |
| [lazy_tasks.md](lazy_tasks.md) | `lazy_tasks` | User opens Challenge for a concept with no tasks, or regenerates |
| [topic_filter.md](topic_filter.md) | (candidate topic-fit filter) | User runs the configured/ChatGPT topic filter in Candidate Review |
| [concept_enrichment.md](concept_enrichment.md) | (concept field fill) | User clicks "Fill w/ LLM" / pastes ChatGPT JSON on a concept Overview |

## Universal invariants (all passes)

1. **Source is truth.** Ground every claim in the supplied source/concept
   context. A confident wrong answer is worse than "insufficient evidence."
2. **Never invent constellations.** `where_reappears` is user-curated only; no
   pass writes it. (Enforced in code — the persist forces `[]`.)
3. **Never overwrite user-authored content** (notes, renamed display names,
   profile).
4. **JSON only** when `responseFormat: 'json'` — no prose, no markdown fences.
5. **Degrade safely.** On unparseable output, fall back to the documented empty
   shape; never throw away user input or corrupt existing rows.
