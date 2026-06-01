# Contract: `concept_enrichment`

- **Contract version:** 1.0.0 (see `CONTRACT_VERSION`)
- **Pass:** concept field fill ("Fill w/ LLM" / ChatGPT paste flow)
- **Touches:** concept `definition_text`, `why_exists`, `what_breaks`. UI +
  parse in `apps/desktop/src/renderer/src/components/DetailPane.tsx`
  (`parseChatGptJson`).
- **Runs in:** user clicks "Fill w/ LLM" or pastes ChatGPT JSON on a concept's
  Overview.

## Purpose

Populate a single promoted concept's explanatory fields **from this source's
evidence**, so the learner starts from a grounded scaffold they can edit — not
from the model's generic knowledge of the concept name.

## Inputs

```ts
{
  concept_name: string,
  partial_definition?: string,   // verbatim from source, if any
  source_context?: string,       // evidence quotes / nearby source text
}
```

## Output JSON schema

```json
{
  "definition_text": "1–3 sentences. Precise meaning AS USED IN THIS SOURCE.",
  "why_exists": "1–2 sentences. The problem this concept solves in its domain.",
  "what_breaks": "1–2 sentences. What goes wrong when it is missing or misapplied."
}
```

## Hard invariants

1. **Fill fields from source evidence.** Define the concept as the source uses
   it, anchored to the supplied quotes — not the model's default meaning for an
   ambiguous name.
2. **Never invent constellations.** `where_reappears` is user-curated only; this
   pass must not create cross-concept links. (Even if a `where_reappears` field
   appears in a pasted payload, the persist drops/forces it to `[]`.)
3. **Never overwrite user-authored content.** Only fill the three explanatory
   fields; do not touch user notes, the display name, tags, equations, or
   constellations. Empty fields the user left blank may be filled; non-empty
   user edits are the user's.
4. **Concept rename is out of scope.** `slug` is never changed (promotion
   idempotency depends on `(source_id, slug)`); this pass does not rename.

## Forbidden behavior

- Writing `where_reappears` / constellation links.
- Overwriting existing user-authored notes or fields.
- Defining the concept from general world knowledge when the source's usage
  differs.
- Emitting tasks, grades, evidence spans, or hub membership.

## Failure behavior

- On unparseable paste/response, change nothing and surface a parse error
  ("expected `{definition_text, why_exists, what_breaks}`"); never blank out
  existing field values.
- Partial output is applied field-by-field: a missing key leaves that field
  untouched.

## Example

Input: concept "Eventual consistency", `source_context` from a distributed-systems
source.

Output:

```json
{
  "definition_text": "A consistency model where, given no new writes, all replicas converge to the same value, but reads may briefly return stale data.",
  "why_exists": "It lets a system stay available and partition-tolerant by relaxing the requirement that every read see the latest write immediately.",
  "what_breaks": "If the application assumes read-your-writes, users can see their own updates vanish until replicas converge, causing confusing or incorrect behavior."
}
```
