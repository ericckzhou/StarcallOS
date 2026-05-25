# StarcallOS — Codex Guide

## Product
**StarcallOS** — Evidence-based knowledge operating system for learning ML/AI concepts from PDFs.

Not a summarizer. Not chat-with-PDF. A system that converts source material into **verified understanding** through a candidate-first ingestion → human curation → evidence task → grading loop.

## Mental Model — Candidate-First Pipeline

**Default invariant**: in deterministic mode, the LLM only fires after a
human commits attention by promoting a candidate or submitting a challenge.
The compare/debug modes intentionally spend LLM calls during processing.

```
PDF  →  geometry segmentation  →  deterministic candidate parser
                                       ↓
                              persist (zero LLM cost)
                                       ↓
            user reviews candidates, applies filters, promotes
                                       ↓
                            promotion (pure DB upsert)
                                       ↓
              user opens concept's Challenge Me tab
                                       ↓
            lazy task generation (1 LLM call per concept)
                                       ↓
                       user answers an evidence task
                                       ↓
                grader (1 LLM call) → mastery stage updated
```

Three extraction modes (Settings → Extraction Mode):
- **deterministic** (default, $0/book) — runs only the candidate parser; candidates ARE the concepts.
- **candidate_gated** (compare/debug) — runs LLM enrichment limited to ±1 page around top-50 candidate evidence pages.
- **full** (legacy benchmark) — sends every block through the enricher; expensive.

In deterministic mode, concept enrichment, evidence tasks, and grading are lazy
and user-triggered. In `candidate_gated` and `full`, processing also runs the
LLM extraction stack and persists semantic chunks, LLM concepts, edges,
misconceptions, and tasks for comparison/benchmarking.

## Architecture

Electron desktop app. Local-first, TypeScript/Node end-to-end.

```
packages/services/   evidence engine (pure TS, Node.js only, no DOM)
packages/shared/     IPC type contracts (renderer ↔ main) — SINGLE SOURCE OF TRUTH
apps/desktop/        Electron: main process + preload + renderer (React)
```

**Process boundary rule:** Renderer never touches SQLite or API keys.
All data flows: renderer → contextBridge → IPC → main → services → DB.

## Data Model (migrations 0001 → 0010)

```
sources                    PDF/text inputs + topic_anchors_json + llm_filter_keep_terms_json
semantic_chunks            LLM-enriched blocks (only populated in candidate_gated/full modes)
concepts                   promoted candidates OR LLM-extracted; evidence_json snapshot
concept_edges              requires | enables | related | causes | contrasts_with | example_of | prevents
misconceptions             attached to concepts: description, why_think_it, why_wrong
evidence_tasks             5 kinds: definition | connection | application | misconception_resistance | compression
mastery                    compression_stage 0–5 per concept
evidence_records           graded attempts (append-only-ish)
events                     APPEND-ONLY audit log

concept_candidates         deterministic candidates (term, confidence, signals, evidence, topic_relevance_score, is_boilerplate, is_broad)
relation_candidates        deterministic relations (from → kind → to)
equation_candidates        deterministic equations (latex, variables, attached_term)
misconception_candidates   deterministic misconception phrase spans

parse_runs                 append-only audit of every Process click (mode, duration_ms, llm_call_count, llm_input_tokens, llm_output_tokens, diagnostics_json, parser_version, grammar_version, layout_version)
```

## Mastery Model (compression stages)
```
0  Unseen
1  Memorized definition
2  Can explain in own words
3  Can connect to other concepts
4  Can compress to first principles
5  Can predict failures / misuse
```

## LLM Provider Abstraction

`packages/services/src/core/llm.ts` exposes one `chatJSON(config, request, passName)` that dispatches to Groq SDK or `@anthropic-ai/sdk`. Config resolved per-call via `resolveProviderConfig(settings, passName)` in `core/settings.ts`:

- Settings: provider (groq | anthropic), API keys per provider, heavyModel, lightModel, extractionMode
- Stored in `<userData>/settings.json`
- Heavy passes (enrich, chunker, concepts, misconceptions, tasks, grader, lazy_tasks): use `heavyModel`
- Light passes (structure, graph): use `lightModel`
- Cross-provider safety: stored model is validated against `MODEL_CHOICES[provider]`; falls back to provider default if mismatch (e.g., switched provider but stored an Anthropic name)
- Groq `max_tokens` capped at 4096 to stay under free-tier 6K TPM
- Anthropic JSON mode emulated via system prompt; markdown fence stripping in wrapper

## Parser Versioning

Hand-bumped in `packages/services/src/core/version.ts`:
- `PARSER_VERSION` — `candidates.ts` + `topic.ts` (signal weights, scoring)
- `GRAMMAR_VERSION` — `grammar.ts` + `equations.ts` (regex patterns)
- `LAYOUT_VERSION` — `layout.ts` (geometry segmentation, classify hints)

Every `concept_candidates` row stamps `parser_version`. Every `parse_runs` row stamps all three. Bump after behavioral changes so diffs across runs are traceable.

## Candidate Quality Pipeline

In `extractCandidates(blocks, sectionPaths, topicAnchors)`:

1. **Heading-derived candidates** (signal weight 0.55) — block hint = heading/subheading, strip `#`, leading numbering, trailing colons.
2. **Definition patterns** (0.40) — `findDefinitions` in `grammar.ts`: `X is defined as Y`, `X refers to Y`, `X is a type of Y`, etc.
3. **Bold isolated lines** (0.30)
4. **Repetition** (0.25) — capitalized phrase appears ≥4×
5. **Capitalized phrases** (0.10) — fallback signal

Signals stack additively, capped at 1.0. Plus deterministic quality flags computed in the same pass:

- `is_boilerplate` — normalized term matches `BOILERPLATE_HEADINGS` (Summary, References, Index, …)
- `is_broad` — single short word, no definition signal, low mention count (e.g., "Coding", "Data")
- `topic_relevance_score` (0–1) — Jaccard-ish overlap between (term tokens + evidence tokens) and per-source `topic_anchors_json`
- `topic_anchors` derived once per source from title (×3 weight) + heading vocabulary (×1)

The Candidates UI buckets these into: **All / High (≥0.85) / Medium / Low / Off-topic / Too broad / Boilerplate / Suspicious**. Bulk-promote uses a strict gate (confidence ≥ 0.9, mention_count ≥ 2, topic_relevance ≥ 0.55, no quality flags).

## Promotion = Pure DB Upsert

`promoteCandidate(db, candidateId)`:
1. Idempotent on `(source_id, slug)` collision
2. Confidence → importance: ≥0.9 = core, ≥0.55 = supporting, else peripheral
3. Definition seeded from strongest non-synthetic evidence quote (skips `repetition` / `capitalized_phrase` sources whose "quotes" are count labels like "appears 107×"; skips tautologies)
4. Evidence quotes snapshotted onto `concepts.evidence_json` so the Source viewer can show real page numbers even after the candidate row is deleted
5. Emits `concept.promoted_from_candidate` event
6. `upsertMastery(id, 0)`

## Re-extract Semantics

`clearDerivedDataForSource(db, sourceId, { preserveUserData: true })`:
- Always wipes: `concept_candidates`, `relation_candidates`, `equation_candidates`, `misconception_candidates`, `semantic_chunks`
- For `concepts`: preserves any concept with study history (`evidence_records`) OR non-empty `evidence_json` (= manually promoted from candidate). Deletes only LLM-generated/untouched ones.
- Never touches: `sources`, source file, `events`

Startup: `recoverInterruptedSources(db)` flips any `status='processing'` (killed mid-run) → `status='failed'` with recoverable error message.

## LLM Topic-Fit Filter

UI workflow (CandidateReview → LLM topic filter modal):
1. Generates prompt asking external LLM (ChatGPT) to keep/reject candidates against the source title
2. User pastes JSON reply; parser is fence-tolerant
3. Decisions are **term-keyed** (stable across re-extracts); legacy id-keyed replies are still accepted during paste
4. Persisted as normalized terms in `sources.llm_filter_keep_terms_json` (legacy `llm_filter_keep_ids_json` saves are read/backfilled; numeric ID saves auto-wiped on read)
5. Toggle chip in bucket bar to enable/disable without losing the saved set

## UI Layout (current)

```
┌──────────────────────────────────────────────────────────┐
│ Sources | Review | Settings                               │
├─────────┬────────────────────────────────────────────────┤
│ Sources │ Candidates | Concepts | Runs                    │
│ (list)  ├────────────────────────────────────────────────┤
│         │ Bucket chips: All|High|Med|Low|Off|Broad|Boil… │
│         │ Signal chips: Any|Heading|Definition|Bold|…    │
│         │ LLM-kept toggle (when filter saved)            │
│         │ Promote N eligible / Promote N visible / Refresh│
│         │ Candidates list (or Concepts + DetailPane)      │
└─────────┴────────────────────────────────────────────────┘
```

DetailPane tabs: **Overview** (editable fields + ChatGPT prompt + enrich) · **Challenge Me** (lazy task gen + answer + grade) · **History** · **Source** (pdf.js viewer with evidence side rail)

## Key Rules

- `node:sqlite` loaded via require() wrapper (`src/core/infra/sqlite.ts`) — Vite can't resolve `node:sqlite` directly
- All `events` are append-only; never UPDATE or DELETE from events table
- No Python in critical path
- `better-sqlite3` excluded — needs Visual Studio Build Tools on Windows; use `node:sqlite` only
- JSON columns parsed at repo layer (`evidence`, `where_reappears`, `chunk_ids`, `evidence_json`, `topic_anchors_json`, etc.)
- API keys stored in main-process `settings.json` only; renderer sees only `*Configured: boolean`
- After editing `packages/services` or `packages/shared`, **rebuild before restarting Electron** (`pnpm -C packages/services build && pnpm -C packages/shared build`) — electron-vite consumes their `dist/`
- `import.meta.env.GROQ_API_KEY` and `ANTHROPIC_API_KEY` from `.env` are env-fallbacks only; saved settings take precedence

## Commands

```
pnpm test              # vitest (packages/services)
pnpm typecheck         # tsc --noEmit across all packages
pnpm build             # compile all packages
pnpm -C apps/desktop dev    # electron-vite dev server
```

## SQLite Note

Uses Node.js 22 built-in `node:sqlite` (experimental). No native compilation required. Electron 36 ships its own Node which honors the same require.

## Current State (snapshot)

Shipped: candidate parser, equations, relations, misconception phrases; deterministic mode (default); candidate_gated mode (LLM-cheap); full mode (legacy); per-provider settings (Groq + Anthropic); per-source topic anchors; bucket + signal + LLM filters with persistence; bulk-promote w/ safe-default gate; lazy task gen; lazy concept enrichment; ChatGPT prompt round-trip; PDF viewer with evidence side rail; parse_runs audit; Re-extract preserving user data.

Queued (not blocking): refactor `CandidateReview.tsx` into per-panel files; per-pass model override UI; many-to-one equation links; CSS design tokens; more tests for `promotion`, `cleanup`, `enrich_concept`.
