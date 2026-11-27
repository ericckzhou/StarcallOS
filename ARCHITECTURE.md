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

## Data Model (migrations 0001 → 0041)

Files live in `packages/services/migrations/`. Note two files share the `0011`
prefix (the runner warns; order is by full filename).

```
sources                    PDF/text/URL inputs + topic_anchors_json + llm_filter_keep_terms_json; origin_url (0027)
semantic_chunks            LLM-enriched blocks (only populated in candidate_gated/full modes)
concepts                   promoted candidates OR LLM-extracted; evidence_json snapshot; tags_json (0023); reviewed_at (0021);
                           origin manual|promoted|llm, NULL = unknown/legacy (0038); user_modified_at (0038)
concept_notes              user notes per concept; linked_annotation_id → a PDF highlight (0022)
concept_edges              requires | enables | related | causes | contrasts_with | example_of | prevents
prerequisite_suggestions   DERIVED suggested prerequisite edges; only user accept writes concept_edges (0028)
misconceptions             attached to concepts: description, why_think_it, why_wrong
evidence_tasks             5 kinds: definition | connection | application | misconception_resistance | compression; retired_at (0035)
mastery                    compression_stage 0–5 per concept
concept_srs                SM-2 card per concept, FSRS stability/difficulty (0034); drives the review queue (0025)
evidence_records           graded attempts; grounding (0029), confidence/calibration (0030), grader audit trail (0032)
pdf_annotations            source/concept-scoped highlights and sticky notes
star_hubs / star_hub_members  named/color cross-source concept groups (0019)
star_hub_edges             user-curated hub ↔ hub links (0026)
llm_calls                  APPEND-ONLY LLM call metadata (pass/model/tokens/latency/prompt hash, never prompt text) (0031)
embeddings                 local vectors, owner_kind concept | span (0033) | chunk (0036); DERIVED except chunk rows
rag_chunks / rag_chunks_fts  retrieval passage index + FTS5 BM25 table kept in sync by triggers (0036)
ask_history                user-owned saved Ask results per concept, newest 50 (0037)
events                     APPEND-ONLY audit log

concept_candidates         deterministic candidates (term, confidence, signals, evidence, topic_relevance_score, is_boilerplate, is_broad)
relation_candidates        deterministic + user relations (from → kind → to);
                           origin parser|user, NULL = unknown/legacy; user_modified_at; source_key (0040)
equation_candidates        deterministic + user equations (latex, variables, attached_term);
                           origin parser|user, NULL = unknown/legacy; user_modified_at; source_latex (0039)
misconception_candidates   deterministic + user misconception phrase spans; origin/user_modified_at/source_key (0040)
candidate_rejections       user rejections kept across re-extract, keyed on parser identity; undoable (0041)

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

## Retrieval Chunk Index (RAG foundation, migration 0036)

A deterministic, zero-LLM passage index over every processed source. It is the
foundation of local question answering (the Ask tab, below); retrieval itself
is a services API measured by an offline eval.

```text
layout blocks (segmentPdf / segmentText, unchanged)
  -> chunkBlocks (ingestion/chunker.ts)      section-bounded, page-traceable chunks
  -> syncSourceChunks (repos/rag_chunks.ts)  reconcile by content key
  -> rag_chunks + rag_chunks_fts (FTS5)      BM25 keyword index, kept in sync by triggers
  -> embeddings owner_kind='chunk'           opt-in local vectors (indexSourceChunkEmbeddings)
  -> retrieveChunks (knowledge/retrieval.ts) keyword | vector | hybrid (RRF)
```

- **Chunker** (`CHUNKER_VERSION`): never crosses a section boundary, never
  splits a layout block (except a single block over `maxChars`, split at
  sentences), never starts a chunk with a formula and keeps short "where ..."
  continuations with it, keeps a heading with the block after it, carries up to
  `overlapChars` of whole trailing blocks into the next chunk of the same
  section. Defaults: target 1000 / max 1800 / min 200 / overlap 200 chars.
  It drops numeric figure-label noise and, as a backstop, any page-numbered
  running headers that still arrive as headings before calling the existing
  `buildSectionPath`.
- **Running headers** (`LAYOUT_VERSION` 0.5.3, `detectPrintedPageHeaders` in
  `layout.ts`): margin lines (fixed band OR a page's first/last line) whose
  leading/trailing integer `n` votes for offset `n − page`; when one offset wins
  on ≥ max(5, 20% of pages) pages, every margin line whose number equals
  `page + offset` is stripped. This catches chapter-scoped and one-off headers
  that the book-wide repeat set misses. On b36 (offset −8) it strips 257 lines
  and drops heading blocks from 326 to 122.
- **Identity**: `chunk_key` = sha256(text) prefix + `#` + duplicate index. Stable
  while the text is unchanged, so re-processing an unchanged document writes
  nothing, keeps every chunk id, and never re-embeds. Eval labels reference it.
- **Lifecycle**: processing and manual re-extract call `syncSourceChunks` right
  after candidate persistence (failures are logged + recorded in parse-run
  diagnostics, never fail processing). `clearDerivedDataForSource` does NOT wipe
  chunks or chunk vectors — they are reconciled instead. Source delete cascades
  (rows, FTS entries via trigger, vectors). `deleteSourceChunks` removes one
  source's index. Sources processed before 0036 get chunks on their next
  process / re-extract (no forced backfill).
- **Vectors** reuse the existing `embeddings` table, text-hash caching and model
  column; nomic models get `search_document:` / `search_query:` prefixes.
  `indexSourceEmbeddings` (concept/span) is scoped to its own kinds so it can no
  longer prune chunk vectors. Processing never embeds. Chunk vectors are written
  only by `indexSourceChunkEmbeddings`, which runs on demand from three places:
  lazily on Ask, the per-source **Index** button (`rag.indexSource`), and the
  user-started library job (below). Embedding goes to the local
  OpenAI-compatible server at `localBaseUrl` only.
- **Retrieval**: FTS5 query is built from quoted unicode word tokens (stopwords
  and single letters dropped, OR-combined), so user text can never become FTS
  syntax. BM25 weights text 1.0 / section path 0.5. Vector = brute-force cosine:
  every query loads ALL chunk vectors of the model for the selected sources
  (`loadChunkVectors`, no cache), scores each, sorts, and keeps the top 50.
  Hybrid = Reciprocal Rank Fusion (k = 60, pool 50), ties broken by best single
  rank then chunk id. When vectors are unavailable a hybrid request degrades to
  keyword and says so in `mode_used` + `vector_error`; it is never silent.
  Filters: `sourceIds`, `k`, `minSimilarity`.
- **Vector cost** (`node --expose-gc evals/bench_vector.mjs`, 2026-11-26, Ryzen 7
  7700X, 768-dim, median of 7): hybrid retrieval 18 ms at 1k chunks, 163 ms at
  10k, 1.1 s at 50k; ~88% of that is reading + decoding the BLOBs, the cosine
  math is 80 ms even at 50k. One 50k-chunk query transiently holds ~0.3 GB.
  For scale, the 275-page b36 textbook is 657 chunks, so 10k ≈ 15 such books,
  and a local Ask answer takes ~2 s. Kept as is: an ANN index would speed up
  the cheap part. If libraries approach ~50k chunks, the justified next step is
  an in-process vector cache invalidated on index writes, not a vector DB.
- **FTS5** is verified in both runtimes that open the DB (Node 22.16 / SQLite
  3.49.1 for tests, Electron 45 / SQLite 3.54.1 for the app); `hasFts5(db)` is
  the runtime check, covered by a test.
- **Built in PR 2 (Ask)**: chunk vectors are generated lazily on Ask (below);
  per-source backfill for pre-0036 sources is the Ask rail's **Index** button.
- **Eval**: `pnpm eval:retrieval -- --pdf <b36-txtbook.pdf>` (see
  `evals/README.md`). Labels are `reviewed` (signed off 2026-11-26).

## Library passage index

`knowledge/library_index.ts`; controls in the Ask rail ("Passage index") and
Settings → Passage index (both `LibraryIndexPanel.tsx`).

- **Plan** (`planLibraryIndex`, pure read): per source, `chunk` (no chunks),
  `rechunk` (any chunk stamped with an older `chunker_version`/`layout_version`),
  and, when embeddings are on, chunks missing a vector for the model. Run order:
  unindexed, then stale, then embed-only; fewer pages first in each group.
- **Run** (`runLibraryIndex`): re-segment and reconcile chunks only (candidates,
  concepts, notes, history untouched), then `indexSourceChunkEmbeddings`.
  Segmentation, embedder, lock, progress and stop are injected, so the runner is
  tested with fakes.
- **Resumable with no job table**: chunks commit per source and vectors per
  64-chunk batch, and vectors are reused by (model, text hash). Stop is checked
  between sources and between batches. Resuming just plans again; finished
  work is never redone.
- **Failures**: a source that fails to chunk (missing file, bad PDF) is recorded
  and skipped. The first embedding failure ends vector work for the run (the
  server is most likely down), but chunking continues. Everything is reported
  in the summary.
- **Never automatic**: the job only starts from a user click (`rag.libraryStart`),
  never at startup. Re-chunking an outdated source updates its passages only;
  its candidates follow on the next re-extract.
- **Per-source lock** (main): the library job, the per-source Index button and
  Ask's lazy embedding serialize on a source. Ask never waits; it skips a busy
  source's embedding and says so in `index_warning`. Index refuses a busy source.
  The job queues behind the lock.
- IPC: `rag.{libraryStatus,libraryStart,libraryStop,onLibraryProgress,onLibraryDone}`;
  `rag.status` sources carry `stale`. Settings' older "Index concepts now"
  button is the separate concept/span index (grading excerpts, related concepts).

## Local Ask (RAG PR 2)

Top-level **Ask** tab (`AskPane.tsx`): pick sources, ask a question, get an
answer whose citations have been checked against the passage text. What the
checks prove is limited (see "What grounded means" below).

```text
rag.ask -> lazy chunk embedding (indexSourceChunkEmbeddings, progress events)
        -> askSources (knowledge/ask.ts)
             retrieveChunks hybrid (k = 6)        no hits -> 'no_passages', no model call
             ONE structured 'ask' call, LOCAL model only (chatStructured + one repair)
             validateAnswer: quotes verified, [n] markers rewritten,
                             analyzeClaims: per-sentence citation coverage + overlap flag
```

- **Local-only generation**: `resolveAskConfig` always returns the `local`
  provider (`localModel` at `localBaseUrl`), whatever the main provider is, so
  retrieved source text never goes to a cloud API. It returns null when no local
  model is set and the main provider is not local; Ask then shows passages only.
- **Citation validation** (pure, `validateAnswer`): every `{passage, quote}`
  must occur verbatim in that passage after `normalizeWithMap` folding (case,
  whitespace, NFKC, all quote marks into one class, dashes, PDF glyphs such as
  TeX's `ǫ`→`ε` and `∗`→`*`, letter-hyphen-letter joined on both sides). Quotes
  under 12 normalized chars are rejected. `"..."` elisions must match in order,
  and EACH piece must reach 12 chars (tiny fragments would match anywhere).
  A verified citation carries `start`/`end` offsets into the original passage
  text, and the UI highlights exactly that span. Unverified citations and
  markers are dropped with a reason, and the answer's `[n]` markers are
  rewritten to verified passages only. Model output is untrusted throughout:
  unknown/negative passage numbers are dropped, and the renderer's marker regex
  is the same one the service rewrote with.
- **Claim coverage** (pure, `analyzeClaims`): the rewritten answer is split into
  sentences (≥ 3 words). Each sentence needs a surviving `[n]` marker, else it is
  `uncited`. A cited sentence fewer than half of whose content words (stopwords
  and single letters dropped, crude stemming, 6-char prefix match) occur in its
  cited passages is flagged `low_overlap`. That threshold was chosen up front,
  not tuned on the eval. It catches obviously unrelated citations and gives
  false positives on heavy paraphrase. A ONE-sentence answer with no markers at
  all gets every verified citation attached (`implicit`), the only unambiguous
  reading; a longer unmarked answer stays uncited. Results carry `claims[]` and
  the constant `verification` (`ASK_VERIFICATION`).
- **What grounded means**: `grounded` = no citation dropped, every claim sentence
  cites a passage with a verbatim-verified quote, and no sentence is flagged.
  It does NOT mean the passage entails the sentence: no entailment check runs
  (`verification.entailment = 'not_checked'`), deliberately no LLM judge, and
  the UI labels it "Citations verified" and says support is not verified.
  `ASK_VERIFICATION.version` (2) is bumped whenever the status rules change.
  Ask history rows saved before v2 have no `verification` object; their
  `grounded` meant only "every listed quote verified", so the UI shows them as
  "Quotes verified (older check)" with a note to ask again, never as
  "Citations verified". A one-sentence answer with no markers that gets its
  quotes attached automatically (`implicit`) says so in the UI.
- **Status**: `grounded` (above) / `partial` (something verified, but a citation
  was dropped or a sentence is uncited/flagged; includes unmarked multi-sentence
  answers) / `qualified` (model flagged the passages insufficient but answered
  with ≥ 1 verified citation) / `unsupported` (no citation verified) /
  `insufficient` (model says the passages don't answer; a bare "insufficient"
  answer becomes null) / `no_passages` / `retrieval_only`. Status names are
  persisted in `ask_history`; old rows lack `claims` and still render.
- **Offline handling**: a model failure (server down, invalid output after the
  one repair) returns `retrieval_only` with `generation_error`, and the passages
  are still shown. Embedding failure degrades to keyword retrieval
  (`mode_used`/`vector_error`); a failed lazy embedding run sets
  `index_warning`. Nothing is silent.
- **Lazy embeddings**: when embeddings are enabled, Ask embeds the selected
  sources' chunks first, streaming `rag:progress`. Each 64-chunk batch is
  committed, so an interrupted run resumes, and vectors with the same model and
  text hash are reused. After the first Ask, later Asks embed nothing.
- **Backfill**: `rag.indexSource` re-segments one source file and reconciles
  its chunks. Candidates and concepts are never touched.
- **Learning loop**: `+ Note` saves the verified answer and its cited quotes
  and pages as an ordinary user-owned note on a concept from the cited sources.
- **Ask about a concept** (PR 3, migration 0037): the DetailPane header **Ask**
  button (hidden on the Challenges tab until the current attempt is graded, so
  lookup never replaces recall) dispatches `starcall:ask`. App switches to Ask
  with that concept as context: an "About" chip, the concept's source selected,
  and agreement-free starter questions that only fill the box. `rag.ask({conceptId})`
  passes the concept name as `focus`, which is appended to the RETRIEVAL query
  only (never the prompt, so verification is unchanged), and saves the result to
  `ask_history`. That table is user-owned, keeps the newest 50 per concept, and
  cascades on concept delete. History is a list of independent verified
  answers, deliberately not a chat thread: prior answers are never fed back
  into the prompt, so the model can't cite itself. `+ Note` defaults to the
  concept (one click; ▾ picks another).
- **Citation → page**: clicking a `[n]` marker, a verified source or a passage's
  "Open page ↗" opens `SourcePagePreview` beside the answer: a read-only render of
  the cited page range (PDF sources only) with the verified quote highlighted and
  scrolled into view, plus prev/next page. It is separate from the concept-bound
  `PdfViewer` and writes nothing. The quote was verified server-side against
  layout text; the preview only LOCATES it, on letters/digits only
  (`spansForQuote`), because pdf.js emits math glyphs as out-of-order text-layer
  spans. Highlighting is line-granular (whole text-layer spans).
- IPC: `rag.{status,indexSource,ask,onProgress,history,historyDelete}`; args
  validated by `RagAskArgsSchema` (question ≤ 2000 chars, optional `conceptId`).

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
- `CHUNKER_VERSION` — `chunker.ts` (retrieval chunk boundaries; stamped on `rag_chunks` rows)

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
- Runs in one SAVEPOINT: a failure part-way leaves the source unchanged.
- Always wipes: `concept_candidates`, `semantic_chunks`.
- `relation_candidates`, `misconception_candidates` (0040), `equation_candidates` (0039): delete only `origin = 'parser'` rows the user never edited; `user`, edited and unknown-origin (legacy) rows survive. Parser output already represented by a kept row is not re-inserted: a parser row matches on its recorded original identity (`source_key` / `source_latex`), a legacy row on its current content, and only user-created rows fall back to a coarse match (relations: page + endpoints + kind).
- Rejections (`candidate_rejections`, 0041) for concept/relation/misconception candidates and prerequisite suggestions are remembered: re-extract skips parser output whose identity was rejected. Undo restores the snapshotted row.
- Both entry points (Re-extract button, bulk outdated job) share one rebuild path (`knowledge/source_rebuild.ts`).
- For `concepts`: deletes only `origin = 'llm'` concepts with no `user_modified_at` and no user data attached (graded attempts, Ask history, SRS card, notes, tags, constellations, hub membership, annotations, edges). Manual, promoted and unknown-origin (pre-0038) concepts always survive. Promoting a candidate onto an existing LLM concept turns it into `promoted`.
- Never touches: `sources`, source file, `events`, `rag_chunks` and chunk vectors (reconciled by `syncSourceChunks` instead)

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
- The grader is **source-grounded**: at submit time the main process assembles
  the concept's source context (`buildGroundingContext` — its definition/why/what
  fields plus deduped evidence-span quotes, token-bounded) and passes it to the
  grader, which additionally scores how well the answer is *backed by the source*
  (`grounding_score` 0–1) and flags `unsupported_claims` — structured
  `{ claim, reason, severity }` objects for assertions the source does not
  support (possible hallucinations / imported outside beliefs). These persist on
  `evidence_records` (`grounding_score`, `grounding_context_used`,
  `unsupported_claims`, migration 0029) and render in the GradeCard + History.
  Grounding is assessed ONLY when real source context exists: a sparse concept
  yields `grounding_score = null` (not "ungrounded") so absence of context is
  never read as hallucination.
- **Confidence calibration** (migration 0030, no LLM): before submitting, the
  learner sets a 0–1 confidence slider ("do I know this, or do I only think I
  know this?"). `SubmitEvidenceArgs.confidenceBefore` is stored as
  `confidence_before` and a `calibration_gap = confidence_before − outcome` is
  derived at grade time (outcome maps the grade to 0–1). Positive gap =
  overconfident. The Profile "Calibration" card rolls these up across rated
  answers (mean gap + over/well/under-confident counts within a 0.15 tolerance),
  and the GradeCard shows a per-attempt verdict. Legacy/unrated records are
  excluded from all calibration stats.
- Constellations are now cross-source: the Overview typeahead links a concept
  to any promoted concept across all sources (the suggestion row shows the
  other concept's source filename). Entries are user-curated only — enrich,
  the ChatGPT paste flow, and the generated prompt never write the
  constellations list.
- The Review Queue is **SRS-driven** (SM-2, `concept_srs` migration 0025). It
  lists **all** promoted concepts with their due state — it does not hide
  scheduled cards — ordered by urgency (brand-new → most-overdue → due →
  soonest-future), each row showing a due badge (`new` / `due now` /
  `overdue Nd` / `due in Nd`). Grading a challenge, the `✓ Done` action, and a
  manual **reschedule** (clock ⏰ → preset popover, `review:setDue` →
  `setConceptSrsDue`) all just advance the card's `due_at`, so the row stays
  visible with an updated badge rather than disappearing. A `due_at IS NULL`
  card is **new** (never scheduled), not due: `countDueConcepts` counts only the
  due-now subset and `countNewConcepts` the new subset, so `review:dueCount`
  returns `{ newCount, dueCount }` and the nav badge reads `N new · M due`
  instead of mislabeling new cards as due. Deleting an
  evidence record replays the survivors. The pure scheduler is
  `src/knowledge/srs.ts`. The header has a sort-cycle button (default →
  importance → stage), persisted in localStorage; refetch is event-driven (no
  Refresh button).
- A concept exports to **Markdown** (`.md`) or an **Anki** import file (`.txt`,
  tab-separated; not `.apkg`) from the DetailPane header (`ExportButton`). Pure
  formatters live in `services/src/export.ts`; the `export:concept` IPC handler
  gathers the concept, source title, notes, equations, and SRS state, then owns
  the Save dialog and file write. Anki emits one Front/Back card per concept
  (LaTeX in MathJax `\[ \]`). **Bulk export** is also available from the
  Sources sidebar — a per-source button and a whole-library button — via
  `export:bundle` (scope `source`|`library`): the same formatters bundle many
  concepts into one file (Markdown demotes each to an h2 under a title; Anki
  emits one row per concept).
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
  rendered PDF to evidence pages. On PDFs a "≈" toggle searches by meaning
  (hybrid retrieval over the source's passage index, one hit per page; falls
  back to keyword with an explanation when vectors are unavailable).
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

**Shipped — prerequisite / dependency engine:** the prerequisite edges ARE the
constellation lines made traversable. `concept_edges` of kind `requires`/`enables`
form a directed DAG with the convention `from_id` = prerequisite, `to_id` =
dependent. `prerequisites.ts` (`getConceptPrerequisites`) returns `learnFirst`
(transitive prerequisites, topologically ordered deepest-first), `unlocks`
(transitive dependents), and `blocked` (direct prerequisites below mastery
stage 2) — cycle-safe (Kahn + `hasCycle`) and node-bounded. Edges remain
**user-curated**: a derived suggestion layer (`prerequisite_suggestions`,
migration 0028) turns the deterministic `requires`/`enables` relation candidates
into directed edge proposals (`computeDeterministicSuggestions`) that NEVER
auto-write — only user accept writes a real `concept_edges` row, preserving the
"no LLM/parser silently writes edges" invariant. Direction: "A requires B" ⇒ B is
B's prerequisite of A (flipped); "A enables B" ⇒ A is the prerequisite of B. No
self-edges anywhere (DB CHECK + `createEdge` guard + IPC refine). Surfaced in the
DetailPane Overview "Prerequisites" section (learn-first/unlocks, manual
add/remove, suggestion accept/reject, "Scan source"), as directed arrows on the
Map, and as a "learn first" dependency-failure badge in the review queue
(`listReviewQueue.blocked_prerequisites`). This realizes the previously-planned
"Dependency failure" study signal.

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

**Shipped — hub nesting:** a hub can have a parent (`star_hubs.parent_hub_id`,
`ON DELETE SET NULL` re-roots children when a parent is deleted). `createHub`
and `updateHub` accept `parentHubId` (tri-state on update: omitted = unchanged,
`null` = top-level, id = nest under that hub); a `wouldCycle` guard throws on a
self/descendant parent. The **Hubs tab** renders hubs as an indented tree with a
Parent picker (options exclude the hub and its descendants). Nesting is
organizational — the Map still draws each hub as its own nebula by direct
membership.

**Shipped — cross-hub edges:** user-curated relationships between two hubs
(`star_hub_edges`, migration 0026), optionally labeled and directional
(one-way/mutual), cascading away when either endpoint hub is deleted. Managed
per-hub in the **Hubs tab** ("Links" row) and rendered on the **Map** as dashed
violet lines between hub-nebula centroids (drawn only when both endpoints have a
cluster on the current view).

**Still planned:** member roles (`core`/`supporting`/`prerequisite`/…) and
Map-rail indentation by parent.

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

Queued (not blocking): more tests for annotations and candidate CRUD. Image sources import via local OCR (tesseract.js, bundled English model; see CLAUDE.md). (Known/benign: duplicate `0011` migration prefix is intentional and already applied — do not rename.)

(Shipped recently: source/library/concept export to Markdown/Anki; URL import with readability + Markdown structure; DOCX and PPTX importers; consolidated `+ Add` source menu; hub nesting, cross-hub edges, and member roles; Map-rail nesting by parent; ID-based constellation links; full-coverage paced/bounded LLM topic filter; URL "Open original".)
