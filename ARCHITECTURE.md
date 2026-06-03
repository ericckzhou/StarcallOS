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

## Data Model (migrations 0001 → 0025)

```
sources                    PDF/text inputs + topic_anchors_json + llm_filter_keep_terms_json
semantic_chunks            LLM-enriched blocks (only populated in candidate_gated/full modes)
concepts                   promoted candidates OR LLM-extracted; evidence_json snapshot; tags_json (0023); reviewed_at (0021)
concept_notes              user notes per concept; linked_annotation_id → a PDF highlight (0022)
concept_edges              requires | enables | related | causes | contrasts_with | example_of | prevents
misconceptions             attached to concepts: description, why_think_it, why_wrong
evidence_tasks             5 kinds: definition | connection | application | misconception_resistance | compression
mastery                    compression_stage 0–5 per concept
concept_srs                SM-2 spaced-repetition card per concept; drives the review queue (0025)
evidence_records           graded attempts (append-only-ish)
pdf_annotations            source/concept-scoped highlights and sticky notes
star_hubs / star_hub_members  named/color cross-source concept groups (0019)
events                     APPEND-ONLY audit log

concept_candidates         deterministic candidates (term, confidence, signals, evidence, topic_relevance_score, is_boilerplate, is_broad)
relation_candidates        deterministic relations (from → kind → to)
equation_candidates        deterministic equations (latex, variables, attached_term)
misconception_candidates   deterministic misconception phrase spans

parse_runs                 append-only audit of every Process click (mode, duration_ms, llm_call_count, llm_input_tokens, llm_output_tokens, diagnostics_json, parser_version, grammar_version, layout_version)
```

## Recent Schema And Parser Additions

- Candidate metadata now includes explicit score parts, labels, typography
  signals, context snippets, and parser diagnostics after re-extract.
- Candidate scoring is split into `typography_score`, `signal_score`,
  `quality_score`, `context_score`, and `final_score`; `confidence` remains for
  compatibility.
- Candidate labels include `section_heading`, `defined_term`, `bold_emphasis`,
  `large_font`, `repeated_term`, `domain_phrase`, `weak_heading`,
  `sentence_fragment`, `caption_or_figure`, `toc_or_index`, and `low_context`.
- Candidate buckets use `final_score`: High >= 0.80, Medium 0.55-0.79, Low
  below 0.55, with separate suspicious/off-topic/broad/boilerplate buckets.
- Equation candidates carry nearest concept/section attachment so the equation
  list can group formulas under their source topic rather than leaving them
  unattached whenever possible.

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

In `extractCandidates(blocks, sectionPaths, topicAnchors)`, candidate scoring is
deterministic and decomposed rather than a single opaque signal:

1. **Typography score** — font-size ratio, bold/italic/all-caps signals,
   isolation, indentation, y-gaps, and heading depth.
2. **Signal score** — heading, definition pattern, repetition, capitalized
   phrase, bold emphasis, and domain phrase signals.
3. **Quality score** — phrase completeness, token count, specificity, generic
   word checks, formula/caption/TOC/index/fragment penalties.
4. **Context score** — nearby definition/domain support, same-page neighbors,
   previous heading path, adjacent body blocks, and source-page relevance.
5. **Final score** — the UI sort and promotion score. `confidence` remains for
   compatibility with older rows and contracts.

Candidate rows also expose parser labels such as `section_heading`,
`defined_term`, `bold_emphasis`, `large_font`, `repeated_term`,
`domain_phrase`, `weak_heading`, `sentence_fragment`, `caption_or_figure`,
`toc_or_index`, and `low_context`.

The Candidates UI buckets by `final_score`: **All / High (>=0.80) / Medium
(0.55-0.79) / Low (<0.55) / Off-topic / Too broad / Boilerplate /
Suspicious**. Bulk-promote uses a strict gate: strong `final_score`, no
suspicious labels, and either definition support, strong typography support, or
repeated domain-term evidence.

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

The manual prompt and configured **Filter by LLM** button both operate on the
currently visible filtered candidates, not the full source candidate set. The
configured path uses the selected provider/model from Settings and persists the
same normalized keep-term filter. The configured API path is intentionally
compact (small visible batches with short context) so low-TPM providers such as
Groq dev-tier models do not reject the request. Use the manual prompt path when
you want a large-list external LLM review.

## PDF Annotations

PDF annotations are source records with optional concept context:

- `scope`: `concept` or `source`
- `concept_id`: creation context for concept-scoped notes/highlights
- `type`: `highlight` or `note`
- `selected_text`: exact PDF text selected for highlights
- `label` and `note_body`: editable user metadata
- `rects_json`: page-relative rectangles, allowing multi-line highlights
- `created_from`: `manual_selection`, `manual_note`, or `evidence_quote`
- `deleted_at`: soft-delete marker used for undo/restore

Manual highlights and sticky notes are concept-scoped by default. Source-wide
annotations remain supported but are hidden unless the Source-wide toggle is
enabled. Highlight overlays stay non-interactive so text selection continues to
work; sticky note markers are draggable and persist their normalized position.
New highlights get a random light-palette color (changeable via the popover);
saving the popover closes it.

**Highlight ↔ evidence ↔ note sync.** Creating a highlight also creates a
concept evidence span (`SourceEvidenceKind` gains `highlight`; the span stores
the source `annotationId` so the evidence-rail accent renders the live highlight
color even after the description is edited or recolored). Deleting a highlight
removes its evidence span and clears any note linked to it; deleting that
evidence span removes the backing highlight and clears the note. A user note can
link to a highlight (`concept_notes.linked_annotation_id`, migration 0022) via a
dropdown of the concept's highlights; the note chip jumps to the source page.
Cross-surface refresh rides the `starcall:evidenceChanged` / `starcall:notesChanged`
window events.

## UI Layout (current)

```
┌──────────────────────────────────────────────────────────┐
│ Sources | Review | Map | Hubs             Profile / Settings│
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

DetailPane tabs: **Overview** (editable fields + ChatGPT prompt + enrich) ·
**Challenges** (lazy task gen + answer + grade) · **History**. The concept
title in the header is click-to-rename (display name only; slug stays stable).
The legacy in-tab Source tab was removed — source preview is a right-side
toggle available beside all tabs, backed by the pdf.js viewer and evidence
rail. The preview renders all pages in one continuous vertical scroll
(no Prev/Next paging), fits page width to the pane with − / % / + zoom on
top, exposes a selectable/copyable text layer over each page, and auto-scrolls
to the first evidence page on open. The concept header also shows the
evidence-kind chips (heading / definition / equation / …) next to the
importance tag.

## Recent UX Additions

- `+ PDF` supports multi-select import and creates one source row per selected
  PDF. `+ Text` opens a centered workspace-sized glass overlay for long pasted
  notes, articles, or transcripts.
- Candidate Review has bucket filters, tag filters, a styled min-score slider,
  compact configured LLM filtering inside the topic-filter modal, manual
  ChatGPT topic filtering, and conservative bulk promotion.
- Relations, Misconceptions, and Equations candidate panels support
  add/edit/delete through shared glass inline controls.
- Source preview can be toggled beside all concept tabs, resized by dragging,
  zoomed, narrowed with an evidence rail, and page-anchored across tab/rail
  layout changes.
  It also supports concept-scoped highlights and draggable sticky notes.
- The Review Queue and Sources panels can be minimized/resized where relevant
  and refresh immediately after concept deletion or review-history changes.
  Review Queue groups concepts by source/book with collapsible headers.
- Concept Overview includes user notes styled like the other editable fields;
  user notes are never overwritten by re-extract or enrichment. Overview also
  supports manual equations and typed constellation links.
- Profile owns display name, avatar upload/removal, XP/challenge stats,
  difficulty distribution, background image/video upload, and background
  opacity. The app background applies behind empty/source/review surfaces.
- XP is awarded by highest completed difficulty per concept/task kind, so the
  same question type cannot be farmed repeatedly.
- Deleting a History entry recomputes derived state for that concept: the XP
  winner for the affected (concept, task kind) bucket is re-awarded to the
  next-highest-difficulty surviving attempt, and the mastery stage is
  recomputed as `MAX(compression_stage)` of remaining records (the mastery
  row is removed entirely when no records remain → concept reads Unseen).
- Regenerating Challenge tasks excludes every prompt the learner has already
  seen (live `evidence_tasks` plus every `task_prompt_snapshot` in
  `evidence_records`): the prior prompts are sent to the model as an AVOID
  list, a "twist" instruction asks for a new angle, and any exact normalized
  duplicate that slips through is filtered out after generation.
- The grader always returns a non-empty `gaps_detected`, even on a full
  "understood" score — framed as the stage-N → N+1 next step (missing
  first-principles compression, missing failure mode, missing sibling-concept
  link), so the learner always has a concrete way to push further.
- Constellations are now cross-source: the Overview typeahead links a concept
  to any promoted concept across all sources (the suggestion row shows the
  other concept's source filename). Entries are user-curated only — enrich,
  the ChatGPT paste flow, and the generated prompt never write the
  constellations list.
- The Review Queue is **SRS-driven** (SM-2, `concept_srs` migration 0025):
  membership is "due now" (no card or null/elapsed `due_at`), default order is
  due-first, and each row shows a due badge. Grading a challenge and the `✓ Done`
  action both advance the card's `due_at`; deleting an evidence record replays
  the survivors. The pure scheduler is `src/knowledge/srs.ts`. The header has a
  sort-cycle button (default → importance → stage) whose selection persists in
  localStorage; the old Refresh button was dropped in favor of event-driven
  refetch.
- The top-level source tab defaults to **Candidates** on first launch and
  remembers the last-selected tab thereafter.
- Equation LaTeX renders via **KaTeX** (`LatexMath.tsx`,
  `katex.renderToString({ throwOnError: false })`, fonts/CSS bundled by vite),
  replacing the earlier homegrown parser; raw text is the fallback.
- **Concept tags**: a `+ tag` picker in the DetailPane header (beside the
  importance pill) lists existing tags (`concepts.allTags`) or creates a new one
  with a chosen color. Tags are `concepts.tags_json` (migration 0023); colors
  are a global name-keyed localStorage map. The auto evidence-kind chips are
  read-only but dismissible per concept (hover-×, localStorage).
- **Source search**: a find box filters to matching pages (PDF) or highlights
  matches inline (text source); a "related pages only" toggle scopes the
  rendered PDF to evidence pages.
- **Constellation reason = evidence selector**: the link reason is picked from
  the linked concept's evidence spans (resolving to a span's linked note when
  present, else the evidence title), not free-typed.
- **5s undo** for source delete and concept bulk delete: the DB delete is
  deferred and flushed on unmount (so it commits rather than stranding an
  orphaned row); notes delete likewise.
- Background customization accepts video (`mp4` / `webm`) as well as images;
  video backgrounds autoplay muted and looped behind the app chrome.
- All delete affordances render a compact `×` (not the word "Delete") with a
  descriptive `title`.

## Star Hubs / Constellations Roadmap

**Shipped — flat constellation links:** per-concept cross-source links via the
Overview typeahead (stored in `concepts.where_reappears`; user-curated, never
LLM-written). Each link now carries a required **reason** — stored as
`{ name, reason }` (legacy bare strings still load). Links are directional in the
data (A lists B); a mutual link is when both list each other.

**Shipped — Constellation Map** (top-level "Map" tab): a dependency-free
force-directed SVG graph of promoted concepts. Built from `concepts.graph()`
(`buildConstellationGraph`): nodes = promoted concepts, edges = constellation
links + validated `concept_edges`, with graph stats and a 150-node/300-edge cap.
Single-source focus (selected source + concepts linked to it from other
sources); per-source node color, mastery ring, directional (one-way →) vs mutual
(↔) arrows, same-source solid vs cross-source dashed edges; reduced-motion aware;
node click opens DetailPane beside the graph.

**Shipped — Star Hubs:** named, color-coded groups of concepts (cross-source).
Tables `star_hubs` + `star_hub_members` (migration 0019; `parent_hub_id`
reserved for future nesting). Members are added via Select-mode multi-select in
`ConceptPane` ("Add to ▾"); hubs render as **nebula clusters on the Map**.
There is a dedicated top-level **Hubs tab** (`HubsPane.tsx`) for full
management — create (random default color), inline rename/recolor/describe,
remove members, delete — independent of any source view. The Map rail lists ALL
hubs (dimming ones not on the current source) so a hub whose source was deleted
remains deletable. New-hub default color is randomized. User-curated, never
LLM-written.

**Still planned:** cross-hub edges in the Map, member roles
(`core`/`supporting`/`prerequisite`/…), and hub nesting.

Potential data model:

```text
star_hubs          id, name, description, color, type, importance, parent_hub_id, timestamps
star_hub_members  hub_id, concept_id, role, order_index
```

Useful member roles: `core`, `supporting`, `example`, `prerequisite`,
`application`, `confusing_with`.

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

Shipped: richer deterministic candidate parser, equations, relations, misconception phrases; deterministic mode (default); candidate_gated mode (LLM-cheap); full mode (legacy); per-provider settings (Groq + Anthropic); per-source topic anchors; bucket/tag/min-score + filtered LLM filters with persistence and compact API batching (min-score now applies to the suspicious bucket too); bulk-promote w/ safe-default gate; lazy task gen; lazy concept enrichment; ChatGPT prompt round-trip; continuous-scroll side-by-side PDF viewer with fit-to-width, − / % / + zoom, a selectable/copyable text layer, evidence rail, auto-scroll to the first evidence page, concept-scoped highlights, and draggable sticky notes; click-to-rename concept titles; evidence-kind chips on the concept header; cross-source constellations via Overview typeahead; Challenge-task regeneration that excludes already-answered prompts and adds a twist; grader that always surfaces next-stage gaps; History-delete that recomputes XP winner and mastery stage; Review Queue sort-cycle (default/importance/stage); source tab defaulting to Candidates; user-authored concept notes; profile/avatar/XP/background customization with image **and video** backgrounds; multi-PDF import; centered text-source import overlay; manual concept/equation/candidate CRUD; parse_runs audit; Re-extract preserving user data; running-header section detection (deterministic) with `section_source` provenance; concept search (ConceptPane + Candidate Review, `/` focus); Paper tab (low-chrome autosave scratchpad per concept); constellation links with required reasons; **global Constellation Map** (force-directed SVG, source-focused, directional/cross-source edges, reduced-motion aware, nebula hub clusters, stable per-source-id node color, refetch on constellation edit); **Star Hubs** (cross-source concept groups) with a dedicated **Hubs tab** for full management (create/rename/recolor/remove-members/delete, orphaned hubs included); **KaTeX** equation rendering; **note ↔ highlight ↔ evidence linking** (highlight creates an evidence span carrying `annotationId`, two-way delete sync, notes link to highlights and jump to page); **concept tags** (colored, pick-existing-or-create, dismissible auto kind chips); **source search** (PDF page filter + text inline match) and "related pages only"; **constellation reason via evidence selector**; **5s undo** for source/concept/note delete (deferred delete, flush on unmount).

Queued (not blocking): cross-hub edges in the Map; hub member roles + nesting; full-coverage LLM topic filter (paced multi-batch + 429 backoff, currently 75/call); ID-based constellation links (vs name-based); refactor `CandidateReview.tsx` into per-panel files; per-pass model override UI; CSS design tokens; more tests for `promotion`, `cleanup`, `enrich_concept`, annotations, candidate CRUD, LLM topic filtering, source-preview page anchoring, and `buildConstellationGraph`.
