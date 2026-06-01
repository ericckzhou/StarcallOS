# Contract: `topic_filter`

- **Contract version:** 1.0.0 (see `CONTRACT_VERSION`)
- **Pass:** candidate topic-fit filter (configured API path + manual ChatGPT
  fallback)
- **Touches:** `sources.llm_filter_keep_terms_json` (see
  `packages/services/src/knowledge/repos/sources.ts`); UI in
  `apps/desktop/src/renderer/src/components/CandidateReview.tsx`.
- **Runs in:** user invokes the LLM topic filter in Candidate Review.

## Purpose

Given the currently visible candidate terms for a source, decide which belong to
**this source's subject matter** and which are noise (boilerplate, headers,
generic words). It narrows the review queue; it does not promote, define, or
rank.

## Inputs

- A compact list of **deduped visible candidate terms** (term-only payload).
- The configured API path sends a single batch of up to `LLM_API_FILTER_LIMIT`
  (75) terms to stay under low Groq TPM tiers. The manual ChatGPT prompt is the
  large-list fallback.
- Filtering operates on the candidates currently visible after the user's
  bucket/tag/min-score filters — never the full candidate set.

## Output JSON schema

A decision keyed by **term** (not row id):

```json
{ "keep": ["backpropagation", "chain rule", "gradient"] }
```

(Equivalently a per-term keep/reject map.) Decisions are normalized and stored
as terms in `sources.llm_filter_keep_terms_json`; the legacy
`llm_filter_keep_ids_json` column is mirrored for compatibility and backfilled
on read.

## Hard invariants

1. **Keep/reject by source domain, not generic world knowledge.** A term is kept
   because it is a real topic *of this source*, not because it is a familiar word
   in general.
2. **Decisions must be term-keyed, not row-id keyed.** Row ids are unstable
   across re-extract; terms are the durable key.
3. **Only judge the supplied (visible) terms.** Do not introduce terms that were
   not sent.
4. **Stay within the size budget.** Prefer a single compact term-only call;
   do not expand into multi-batch/dual-provider "full coverage" (that path was
   reverted — it stalled on Groq 429 backoff).

## Forbidden behavior

- Returning row ids as the decision key.
- Inventing or "completing" terms beyond the input list.
- Keeping generic filler ("introduction", "chapter", "figure", "the author")
  just because it is well-formed text.
- Sending the entire candidate list when only the visible subset was requested.

## Failure behavior

- On unparseable output, keep nothing automatically — leave the existing filter
  state unchanged and surface the error; do not silently drop candidates.
- A filter decision is reversible UI state, never a destructive delete of
  candidate rows.

## Example

Input terms (visible subset, ML source): `["backpropagation", "chain rule",
"introduction", "gradient", "acknowledgements"]`

Output:

```json
{ "keep": ["backpropagation", "chain rule", "gradient"] }
```

`introduction` and `acknowledgements` are well-formed but not topics of the
source's subject matter, so they are rejected.
