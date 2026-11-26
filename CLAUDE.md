# StarcallOS - Claude Code Guide

This file is the Claude-oriented operating guide for the current StarcallOS
codebase. `ARCHITECTURE.md` is the canonical product and architecture reference; keep
this file short, current, and action-oriented.

## Working Memory

Remember these as the active state of the repo:

- The current app is already implemented as the candidate-first Electron system;
  it is not the older broad "cognition evidence platform" from `PLAN.md`.
- `ARCHITECTURE.md` is the source of truth for product behavior. This file is a
  Claude memory/operations layer and should not drift into a full duplicate.
- The default user promise is "$0/book processing" through deterministic
  extraction. LLM calls in normal use happen after promotion or challenge
  interaction. `candidate_gated` and `full` are explicit compare/debug modes.
- `README.md` was normalized from UTF-16 to UTF-8 and now points readers to
  `ARCHITECTURE.md`.
- `sources.llm_filter_keep_terms_json` is the current LLM topic-filter column.
  The old `llm_filter_keep_ids_json` column remains as a compatibility mirror.
- Candidate review filters now operate on `final_score`, parser labels, and
  currently visible rows. Both manual ChatGPT prompts and configured in-app LLM
  filtering must send only the visible filtered candidates. The configured API
  filter sends a single compact call of up to `LLM_API_FILTER_LIMIT` (75)
  deduped visible candidates (term-only payload) to stay under low Groq TPM
  tiers; the manual ChatGPT prompt is the large-list fallback. (An earlier
  multi-batch/dual-provider "full coverage" path was reverted — it stalled on
  Groq 429 backoff.)
- Source preview is a shared side pane across concept tabs. Preserve logical
  page anchoring when tabs, rails, zoom, or layout width changes.
- PDF annotations are persisted source records. New manual highlights/sticky
  notes are concept-scoped by default; source-wide annotations are opt-in via
  the Source-wide toggle. Highlights are text-anchored and non-draggable;
  sticky notes are draggable within the source pane.
- Profile/background/XP are local UI state plus DB-backed study progress; XP is
  awarded only for the highest completed difficulty per concept/task kind.
- Multi-PDF import returns an array of source rows from `sources.create({})`.
  Single explicit `filePath` calls remain backward compatible.
- `+ Text` opens a centered workspace-sized glass import overlay. Keep the
  existing text-source API and do not reintroduce the old sidebar form.
- `+ URL` imports a web page as a text-backed source: `sources.importUrl({url})`
  → main fetches (http/https only, 10s timeout, 5 MB cap) → the pure
  `htmlToText` extractor (`ingestion/html_text.ts`, zero-dep tag-strip + entity
  decode) → write `.txt` → `createSource`, riding the same text-source pipeline.
  No page geometry, so candidate quality is lower than a real PDF. DOCX/PPTX/
  image-OCR importers are deliberately out of scope for now.
- Promoted concepts can be manually added/edited/deleted and attached to an
  existing source. Adding a concept opens a centered glass modal overlay (not an
  inline sidebar form). Review queue concepts are grouped by source and
  collapsible.
- Constellations (`where_reappears`) are user-curated ONLY. Enrichment and LLM
  extraction never write them (the full-extraction persist forces `[]`);
  migration 0020 cleared legacy LLM-generated links. Links store `{ name, reason }`
  (legacy bare strings still load); the reason is required on add.
- The prerequisite/dependency engine is shipped. `concept_edges` rows of kind
  `requires`/`enables` ARE the prerequisite DAG, with the convention `from_id` =
  prerequisite, `to_id` = dependent (matches `listRequirementsFor`). Traversal is
  pure TS in `packages/services/src/knowledge/prerequisites.ts`
  (`getConceptPrerequisites` → `learnFirst` topo-ordered deepest-first, `unlocks`
  reverse-reachable, `blocked` = direct prereqs below mastery stage 2
  (`PREREQUISITE_READY_STAGE`); Kahn sort, cycle-safe with `hasCycle`, node-bounded).
  Edges stay user-curated: a derived **suggestion** layer
  (`prerequisite_suggestions`, migration 0028 — derived, wiped by
  `clearDerivedDataForSource`, accepted edges survive on preserved concepts)
  proposes directed edges from deterministic `requires`/`enables`
  relation_candidates via `computeDeterministicSuggestions`. Direction:
  "A requires B" ⇒ B is prerequisite of A (FLIP to `from_id=B,to_id=A`);
  "A enables B" ⇒ A is prerequisite of B (no flip). Suggestions NEVER auto-write
  an edge — only user accept (`acceptPrerequisiteSuggestion`) writes
  `concept_edges`. No self-edges anywhere: DB `CHECK (from_id <> to_id)`, the
  `createEdge` repo guard, and the `ConceptEdgeArgsSchema` IPC refine. UI: the
  DetailPane Overview "Prerequisites" section (`PrerequisitesSection.tsx`) shows
  learn-first/unlocks, manual add/remove edges, and suggestion accept/reject +
  "Scan source"; the Constellation Map already draws accepted `requires`/`enables`
  edges as directed arrows via the existing relation-edge path, and selecting a
  concept dims everything outside its prerequisite sub-DAG (`prereqFocus`). The review queue shows a
  "learn first" dependency-failure badge for due concepts with unmastered direct
  prerequisites (`listReviewQueue` carries `blocked_prerequisites`). IPC:
  `concepts.prerequisites` / `concepts.edgeCreate` / `concepts.edgeDelete` and the
  `prereq.{suggestions,compute,accept,reject}` namespace.
- The grader is source-grounded (migration 0029). At submit, main assembles the
  concept's source context via `buildGroundingContext` (definition/why/what +
  deduped evidence-span quotes, ≥80 non-ws chars to count, capped at 4000) and
  passes it as `gradeResponse`'s `source_context`. The grader then also returns
  `grounding_score` (0–1 or `null`) and `unsupported_claims`
  (`Array<{ claim, reason, severity: 'minor'|'major' }>`), persisted on
  `evidence_records` alongside `grounding_context_used`. Grounding is assessed
  ONLY when context exists — `parseGradeResult(raw, hasContext)` forces the
  not-assessed shape (`null` score, no claims) when `hasContext` is false, so a
  sparse deterministic-mode concept is never scored "ungrounded". These fields
  are intrinsic to one attempt (no delete/replay recompute). `UnsupportedClaim`
  lives in `core/domain/types.ts`; the GradeCard + History rows render a
  grounded/partially-grounded/unsupported badge + claim list. `CONTRACT_VERSION`
  is 1.4.0 (shared counter; 1.4.0 = adaptive lazy tasks); grader contract in
  `contracts/grader.md`. Grader 1.3.0 adds per-stage calibration
  examples to `GRADER_SYSTEM`, optional self-consistency (Settings → Grading,
  `effectiveSelfConsistency`: default on for Anthropic, off for Groq) that
  re-grades `isBorderlineGrade` answers twice at T=0.7 (temperature applies to Groq/local only: Anthropic SDK 1.x / API
  2026-10-21 removed sampling controls, so Anthropic calls never send it) and merges via
  `aggregateGrades` (majority score, ties → conservative; lower-median stage).
  Graded attempts persist via `persistGradedAttempt` (record + mastery + SRS in
  one transaction),
  and an audit trail on `evidence_records` (migration 0032: `grader_output`,
  `grader_prompt_hash`, `grader_model`, `grader_contract`, `grade_samples`;
  kept OFF the DTO, read via `getEvidenceAudit`). The grader's stable prefix
  (system + concept/source block) is marked `cache: true` for Anthropic
  prompt caching (`toAnthropicPayload`). Offline evals: `pnpm eval`
  (`evals/`; all golden sets `reviewed` as of 2026-11-26).
- Confidence calibration is shipped (migration 0030). The ChallengeTab has a
  pre-submit "How confident are you?" slider (0–1, default 0.5, always captured);
  `SubmitEvidenceArgs.confidenceBefore` (Zod `0..1` optional) flows to the
  `EVIDENCE_SUBMIT` handler → `createEvidenceRecord`, which stores
  `confidence_before` and derives `calibration_gap = confidence_before − outcome`
  (`scoreOutcome`: understood 1.0 / recognizes 0.66 / gap 0.33 / misconception 0;
  positive gap = overconfident). Both are intrinsic to the attempt (no
  delete/replay recompute) and null on legacy records. `getStudyProgress` adds a
  `calibration` rollup (`CalibrationStats`: sample_count, mean_gap, over/under/
  well counts, `CALIBRATION_TOLERANCE` 0.15) over records WITH a confidence value;
  the Profile "Calibration" card renders the verdict + an over/well/under bar, and
  the GradeCard shows a per-attempt over/under/well badge. No LLM involved — pure
  compute. (Uncertainty artifacts — ambiguities/conflicts — are deliberately
  deferred to a future Misconception Detective, NOT built here.)
- The review queue is SRS-driven (`concept_srs`, migration 0025). `listReviewQueue`
  lists ALL promoted concepts with their due state (each row carries `due_at`),
  ordered by urgency: brand-new first, then by `due_at` ascending (most-overdue →
  due → soonest-future), then centrality/importance/recency. It does NOT hide
  scheduled cards — grading, the `✓ Done` action, and manual reschedule all just
  update the card's `due_at` so the row stays visible with an updated badge
  (`new` / `due now` / `overdue Nd` / `due in Nd`). A card with `due_at IS NULL`
  is **new** (never scheduled), NOT due — `countDueConcepts` counts only the
  due-now subset (`due_at` not null and reached) while `countNewConcepts` counts
  the new subset; both join `sources` so orphaned concepts can't inflate them.
  `review:dueCount` returns `{ newCount, dueCount }` and the nav header badge
  renders them as an honest `N new · M due` (never labeling a new card "due").
  This supersedes both the
  old `reviewed_at IS NULL` gate (0021) and the interim "membership = due now"
  filter; `reviewed_at` is kept on the row for history only. Grading advances the
  SM-2 card (`recordSrsReview`, beside `upsertMastery` in `EVIDENCE_SUBMIT`); `✓
  Done` is an honest neutral review (treated as `recognizes`); manual reschedule
  is a pure date override (`setConceptSrsDue` via `review:setDue`, SM-2
  ease/reps untouched, `null` = due now). Deleting an evidence record replays the
  survivors (`recomputeSrsForConcept`, beside `recomputeMasteryForConcept` in
  `deleteEvidenceRecord`). The pure SM-2 scheduler lives in
  `packages/services/src/knowledge/srs.ts`; FSRS-5 (default weights) in
  `knowledge/fsrs.ts`. Settings → Grading → Review scheduler picks SM-2
  (default) or FSRS; main calls `setSrsScheduler` at startup and on save, and
  every record/replay path goes through `scheduleReview`. FSRS state is
  `concept_srs.stability/difficulty` (migration 0034); SM-2 cards convert
  lazily on their next review (stability seeded from the SM-2 interval — no
  replay, which would drop `✓ Done` reviews). Overconfident non-`understood`
  attempts (`calibration_gap` > 0.15) get a 0.7× interval under either
  scheduler (also applied on replay). `listReviewQueue` sinks concepts with
  unmastered direct prerequisites below unblocked ones within the same urgency
  bucket (`orderBlockedLast`). Settings persist via `mergeSettingsPatch`
  (never list fields one by one in main — that silently dropped new settings). The queue defaults to expanding only
  the most recently previewed source's group.
- Concepts export to **Markdown** (`.md`) or **Anki** (`.txt`, tab-separated
  import — NOT `.apkg`) via the DetailPane header `ExportButton` (beside
  `RescheduleButton`, in BOTH header variants). Formatters are pure TS in
  `packages/services/src/export.ts` (`toMarkdown` / `toAnki` /
  `renderConceptExport`); the main `export:concept` handler assembles
  `ConceptExportData` (concept + source title + notes + equations + SRS) and
  owns the `dialog.showSaveDialog` + `fs.writeFileSync`. Anki is one Front/Back
  card per concept (definition/why/what/constellations/equations; LaTeX in
  MathJax `\[ \]`); notes are Markdown-only. Args validated by
  `ExportConceptArgsSchema`. Bulk export is also shipped: the SourcePane
  exposes a per-source export button (each ready row), and the **Settings tab**
  has an "Export" section with whole-library Markdown/Anki buttons → `export:bundle`
  (`ExportBundleArgsSchema`, scope `source`|`library`). Bundle formatters
  (`toMarkdownBundle` / `toAnkiBundle` / `renderBundleExport`) reuse the same
  per-concept `ConceptExportData`: Markdown demotes each concept to an h2 under
  a document title with `---` separators; Anki emits one header + one row per
  concept. The main `export:bundle` handler gathers `listConceptsBySource` (one
  source, or every source for `library`) and owns the save dialog/write.
- Star Hubs are shipped: named/color-coded cross-source concept groups
  (`star_hubs` + `star_hub_members`, migration 0019). Members are added via
  Select-mode multi-select in `ConceptPane` ("Add to ▾"; the old in-pane "+ Hub"
  create form was removed — creation now lives in the Hubs tab). Hubs render as
  Map nebula clusters. There is a dedicated top-level **Hubs tab**
  (`HubsPane.tsx`) for full management: create (random default color),
  rename/recolor/describe, remove members, delete. The Map rail lists ONLY hubs
  with a member on the current source (`railHubs` = `orderedHubs` filtered by
  `visibleHubIds`); off-source hubs are hidden, not dimmed, since management/
  deletion lives in the Hubs tab. New-hub default color is randomized. **Hub
  nesting is
  shipped**: a hub can have a parent via `star_hubs.parent_hub_id` (column
  predates this; `ON DELETE SET NULL` re-roots children when a parent is
  deleted). `createHub`/`updateHub` accept `parentHubId` (tri-state on update:
  omitted = unchanged, `null` = top-level, id = nest); the repo's `wouldCycle`
  guard throws on a self/descendant parent. The Hubs tab renders hubs as an
  indented tree (`renderTree`/`renderHubCard`) with a Parent `<select>` in the
  edit form whose options exclude the hub and its descendants. Nesting is
  organizational only — the Constellation Map still draws each hub as its own
  nebula by direct membership.
  **Cross-hub edges are shipped**: user-curated relationships between two hubs
  (`star_hub_edges`, migration 0026; optional `label`, `directed` flag for
  one-way/mutual; cascades on hub delete). Repo CRUD `listHubEdges` /
  `createHubEdge` (rejects self-edge, idempotent on ordered pair) /
  `updateHubEdge` / `deleteHubEdge`; IPC `hubs.edges.{list,create,update,delete}`.
  Managed per-hub in the Hubs tab "Links" row (add target + label + direction,
  `×` to remove); rendered on the Map as a dashed violet `HubEdgeLayer` line
  between nebula centroids (arrow = one-way, double-arrow = mutual), only when
  both endpoint hubs have a cluster on the current view. The Map refetches hub
  edges on `starcall:graphChanged`. **Member roles are shipped**:
  `star_hub_members.role` (core/supporting/prerequisite/example) is set via
  `setMemberRole` (IPC `hubs.setMemberRole`) with a role dropdown on each member
  chip in the Hubs tab; `listAllMemberships` carries `role`. The Map hub rail
  renders the nesting tree (indented by parent).
- Notes ↔ highlights ↔ evidence are linked (migration 0022 adds
  `concept_notes.linked_annotation_id`): a note can link to a PDF highlight (a
  dropdown of the concept's highlights); the chip jumps to the source page.
  Creating a highlight also creates a concept evidence span
  (`SourceEvidenceKind` includes `highlight`; the span stores `annotationId` so
  the rail color tracks the live highlight color across edits/recolor). Deleting
  a highlight removes its evidence span and clears any linked note; deleting that
  evidence span removes the backing highlight and clears the note — both via the
  `starcall:evidenceChanged` / `starcall:notesChanged` window events.
- User concept tags (migration 0023 adds `concepts.tags_json`, array of strings):
  the header `+ tag` picker lists existing tags (`concepts.allTags` IPC) or
  creates a new one with a chosen color. Tag colors are a global, name-keyed
  localStorage map (`starcall.tagColors`) so the same tag looks the same
  everywhere. The auto evidence-kind chips (HEADING/CHUNK/…) are read-only but
  dismissible per concept via hover-× (persisted in localStorage); the
  `highlight` kind is filtered from the header chips entirely.
- Source preview has find-in-source: a search box filters to matching pages
  (PDF) or highlights matches inline (text source). On PDFs the "≈" toggle
  (persisted, `starcall.layout.meaningSearch`) searches by meaning instead:
  `rag.searchSource` → `searchSourcePassages` (`knowledge/source_search.ts`),
  hybrid retrieval over that source's passage index, one hit per page. It never
  embeds or takes the source lock; no vectors / embeddings off / server down
  (8s cap in main) degrade to keyword with a `note`, and an unindexed source
  says so. The header toolbar wraps on narrow panes. "Related pages only" (was
  "Evidence pages only") scopes the rendered PDF to evidence pages. The « Ev / Ev »
  evidence-nav buttons were removed to declutter.
- Constellation link reason is chosen via an evidence selector: it lists the
  LINKED (target) concept's evidence spans; selecting one resolves to the note
  linked to that span's highlight if present, else the evidence title (shown
  with an ellipsis when truncated). The editor resets on concept switch and
  refetches on `starcall:evidenceChanged`.
- Source and concept(bulk) delete use a 5s undo: the actual DB delete is
  deferred and only committed when the timer fires. The pending delete is
  FLUSHED on unmount (e.g. tab switch) so it commits rather than vanishing —
  earlier a cancel-on-unmount left the row deleted in the UI but alive in the DB
  with orphaned concepts/map. Note delete also uses a 5s undo.
- Equation LaTeX renders via KaTeX (`LatexMath.tsx`, `katex.renderToString`,
  fonts/CSS bundled by vite). The old homegrown parser was removed.
- Map node source colors key off `source_id` (stable across concept/source
  delete). Turning the Hubs toggle off shows all nodes (no focus dimming). The
  Map refetches its graph on `starcall:graphChanged` (dispatched on constellation
  edits) so deleted links drop their edges without reload.
- The Constellation Map is a shipped top-level "Map" tab (force-directed SVG over
  `concepts.graph()`, source-focused, directional/cross-source edges,
  reduced-motion aware). It has a left rail (source selector → Hubs →
  concept search → concept list) and defaults to the most recently previewed
  source (`starcall.layout.lastSource`, set on Sources-tab select), falling back
  to the largest source. The footer stats scope to the selected source via
  `graph.statsBySource`. The mastery ring ramps orange→yellow→green by stage.
- Every `chatJSON` call (success or failure) emits an `LlmTraceEvent` to an
  optional sink (`setLlmTraceSink`); main installs `createLlmCallSink(db)`,
  appending metadata only (pass/provider/model/tokens/cache reads/latency/
  retries/`prompt_hash` = sha256 of system prompt, never prompt text) to the
  append-only `llm_calls` table (migration 0031). A throwing sink never breaks
  a call. Settings shows an "LLM usage" table via `llm.traceSummary(days)`.
- Structured LLM passes go through `chatStructured` (`core/structured.ts`):
  a Zod wire schema per pass (`GraderOutputSchema`, `LazyTasksOutputSchema`,
  `EnrichOutputSchema`, `PrereqSuggestOutputSchema`). Anthropic enforces it
  natively as a single forced tool (`ChatRequest.jsonSchema`); Groq stays on
  `json_object`. Invalid output gets ONE repair call (traced as
  `<pass>:repair`), then throws `LlmParseError`. Never substitute a default
  result for bad output — the grader previously recorded unparseable output
  as a real `gap` grade. The topic filter keeps its lenient parser (it also
  parses pasted ChatGPT output) and is traced as `topic_filter`.
- Local embeddings are opt-in (Settings → Embeddings, `embeddingsEnabled`,
  default model `nomic-embed-text`) via an OpenAI-compatible `/embeddings`
  endpoint at `localBaseUrl` (`core/embeddings.ts`; pure fetch, no native/ONNX
  module). Vectors live in the derived `embeddings` table (migration 0033,
  wiped by `clearDerivedDataForSource`), indexed incrementally by text hash
  (`indexSourceEmbeddings`): `concept` rows (name + definition) and `span` rows
  (evidence quotes ≥40 chars). Consumers: grading adds top similar quotes from
  OTHER concepts in the same source to `buildGroundingContext(db, id, extra)`
  (only when the concept has its own material; 8s soft timeout); the
  constellation editor shows "Similar concepts" chips (`embeddings.related`)
  that only START the normal add flow — never auto-link. Candidate Review shows
  a "≈ term" near-duplicate chip (`candidates.nearDuplicates` →
  `findCandidateNearDuplicates`, term-only, `clustering:` prefix for nomic
  models, threshold 0.93 calibrated on nomic; not persisted — main memoizes via
  `createCachingEmbedder`); hints only, never auto-merge. Every consumer must
  degrade silently when embeddings are off/unreachable.
- The RAG retrieval foundation is shipped (migration 0036, PR 1 of local Q&A;
  no UI, no answer generation yet). `chunkBlocks` (`ingestion/chunker.ts`,
  `CHUNKER_VERSION`) turns the existing layout blocks into section-bounded,
  page-traceable chunks. Page-numbered running headers are stripped in
  `layout.ts` (`detectPrintedPageHeaders`, LAYOUT 0.5.3: margin/first/last-line
  numbers voting for one printed-page offset); the chunker's own header filter
  is now only a backstop. `syncSourceChunks` reconciles `rag_chunks` by content-addressed
  `chunk_key` right after candidate persistence in both processing paths —
  unchanged documents write nothing and keep chunk ids. `rag_chunks_fts` (FTS5,
  porter) is trigger-synced. Chunk vectors are `embeddings` rows with
  `owner_kind='chunk'` (on demand via `indexSourceChunkEmbeddings`; processing
  never embeds); `clearDerivedDataForSource` and `indexSourceEmbeddings` must
  never touch chunk rows. `retrieveChunks` (`knowledge/retrieval.ts`) =
  keyword (BM25) | vector | hybrid (RRF k=60), deterministic tie-breaks, and an
  explicit keyword fallback (`mode_used`/`vector_error`) when vectors are
  unavailable. Eval: `pnpm eval:retrieval -- --pdf <b36-txtbook.pdf>` against
  the sha-pinned `evals/golden/retrieval.jsonl` (labels `reviewed` 2026-11-26;
  the repo is public, so labels hold keys + 60-char anchors only).
  `pnpm eval:ask -- --pdf <pdf> --model <local>` scores real Ask answers on
  the same questions (deterministic: status mix, abstention, citation
  precision, dropped citations; no LLM judge; tolerance 0.075). Shared setup
  lives in `evals/pinned_doc.mjs`.
- Local Ask (RAG PR 2) is shipped as a top-level **Ask** tab (`AskPane.tsx`,
  `knowledge/ask.ts`). Generation is LOCAL-ONLY: `resolveAskConfig` always
  returns the `local` provider (pass `ask`) and never a cloud one. Citations
  are verified by `validateAnswer`/`quoteInPassage`: the quote must occur in
  the passage after `normalizeWithMap` folding, and the result carries
  `start`/`end` offsets into the original text, which the UI highlights.
  Unverified citations are dropped and markers rewritten. Status is
  grounded/partial/qualified/unsupported/insufficient/no_passages/retrieval_only
  (`qualified` = the model flagged the passages insufficient but gave a hedged
  answer with ≥1 VERIFIED citation; shown as "Sources partly answer this", not
  a decline). Neighbor expansion (`withNeighbors`, `AskOptions.neighbors`) is
  opt-in/off: it raised citation precision but cost false-premise answers.
  Pre-model abstention was measured and deliberately NOT shipped (top cosine
  does not separate unanswerable questions on the golden set). A model
  failure degrades to `retrieval_only` (passages still shown). Chunk vectors
  are embedded lazily on Ask with `rag:progress`; `rag.indexSource` backfills
  one pre-0036 source; the whole-library job (`knowledge/library_index.ts`,
  `LibraryIndexPanel` in the Ask rail + Settings → Passage index) chunks
  unindexed sources, re-chunks outdated ones (older chunker/layout stamps) and
  embeds everything. It is user-started only (never at startup), resumable with
  no job table (per-source/per-batch commits), and Stop-able; failures are
  skipped and reported. A main-process per-source lock serializes it with
  Index/Ask; Ask skips busy sources (index_warning). Citations open
  `SourcePagePreview` (read-only cited-page render, quote located on
  letters/digits only — pdf.js emits math glyphs as out-of-order spans; never
  use it to VERIFY, only to locate). `+ Note` saves the answer and its citations as a concept
  note. Never loosen the quote check into fuzzy/semantic matching: the
  guarantee is verbatim modulo typography. The concept header **Ask** button
  (hidden on Challenges until graded) opens Ask with that concept as context:
  retrieval `focus` only, per-concept `ask_history` (migration 0037, newest
  50). This is NOT a chat: never feed earlier answers back into the prompt.
- PDF segmentation runs off the main thread: every main-process `segmentPdf`
  call goes through `segmentPdfIsolated` (`apps/desktop/src/main/pdf_parser.ts`)
  → a Node **worker thread** (`parse_worker.ts`, second electron-vite main
  entry, 2 GB heap cap). NOT an Electron utilityProcess: pdf.js keys its
  Node detection off `process.type`, which is `'utility'` there, so it crashes
  on load (`DOMMatrix is not defined`). Worker death fails in-flight parses
  (never retried in-process); a worker that cannot start falls back to
  in-process; `STARCALL_PDF_PARSER=inprocess` forces the old path.
- Optional Docling PDF parser (Settings → PDF parser; default Built-in). The
  user runs their own `docling-serve` (default `http://127.0.0.1:5001`); the app
  never bundles Python. `ingestion/docling.ts`: `convertPdfWithDocling` (async
  API: submit → poll → result, JSON only, OCR off) + `doclingToSegmentation`
  (DoclingDocument 1.x → the same `SegmentedBlock`s; furniture layer dropped;
  section depth from numbering since Docling reports every header as level 1;
  "Chapter N" folded into its title; formula text from `orig`). Main's
  `segmentPdfConfigured` falls back to the built-in worker on ANY Docling
  error. Layout stamp = `docling-<DOCLING_ADAPTER_VERSION>` for Docling-parsed
  PDFs (chunks + parse runs); `expectedLayoutFor(settings)` feeds every
  outdated planner, so switching parsers marks PDFs outdated. A Docling
  fallback during bulk re-extract is reported as skipped. Evals take
  `--parser docling` (label mapping is mechanical; see evals README).
- Bulk "re-extract outdated sources" is shipped (Settings → Outdated sources,
  `ReextractPanel.tsx`; `knowledge/reextract_outdated.ts`; IPC `reextract.*`).
  Outdated = has candidates AND the latest SUCCESSFUL `parse_runs` row has a
  different PARSER/GRAMMAR/LAYOUT version (or no run → `unknown`). The single
  Re-extract button and the job share `reextractSourceCandidates` in main, which
  now records a `parse_run` (`diagnostics.trigger='reextract'`) — without that a
  re-extracted source would stay "outdated" forever. User-started only,
  sequential under `withSourceLock`, Stop between sources, resumable.
- User-facing provider text should say "configured LLM provider" unless a
  feature is truly Groq-specific.
- `.claude/agents/ipc-contract-reviewer.md` is a project review agent that
  checks any IPC change stays in sync across shared (`IPC` const + `IpcApi`),
  main handler, preload bridge, and renderer call site (plus the
  `pnpm -C packages/shared build` step). `.claude/` is gitignored, so it is
  local-only.
- `pnpm` may not be on PATH in this shell. If verification cannot run, say so
  plainly instead of implying tests passed.
- PowerShell may render UTF-8 box drawing and arrows as mojibake. Do not treat
  that display artifact as proof that the source file is corrupted.

## Current Product Shape

StarcallOS is an Electron desktop app for turning PDFs/text sources into
evidence-backed learning loops. It is domain-agnostic (textbooks, papers,
lecture notes, legal/clinical/internal docs — any subject), not ML/AI-specific;
prompts and the README are framed accordingly. It is not chat-with-PDF and not
a generic summarizer.

The default path is candidate-first:

```text
PDF/text -> geometry segmentation -> deterministic candidate parser
         -> user reviews/promotes -> pure DB concept upsert
         -> lazy task/enrichment/grading LLM calls when the user asks
```

Extraction modes in Settings:

- `deterministic`: default, zero LLM during processing.
- `candidate_gated`: compare/debug mode; enriches blocks near top candidate pages.
- `full`: legacy benchmark; enriches all blocks.

In deterministic mode, concept enrichment, evidence task generation, and grading
are lazy/user-triggered. In `candidate_gated` and `full`, processing also runs
LLM extraction and persists semantic chunks, LLM concepts, edges,
misconceptions, and tasks.

## Architecture Rules

- Renderer never touches SQLite, API keys, `fs`, or provider SDKs.
- Data flow is `renderer -> preload/contextBridge -> IPC -> main -> services -> DB`.
- `packages/shared/src/index.ts` is the renderer/main IPC contract.
- `packages/services` is pure TypeScript/Node business logic. No DOM/Electron imports.
- Electron main owns files, settings, DB, LLM calls, and IPC registration.
- `node:sqlite` is loaded through `packages/services/src/core/infra/sqlite.ts`.
- Do not add `better-sqlite3`; it is intentionally excluded for Windows setup.
- `events` is append-only. Never update/delete rows in `events`.
- API keys live in main-process `settings.json`; renderer only sees configured booleans.

## Repo Map

```text
packages/services/   evidence engine, parser, repos, LLM wrapper
packages/shared/     IPC names and shared DTO/types
apps/desktop/        Electron main/preload/React renderer
```

High-change areas:

- Candidate parser: `packages/services/src/ingestion/candidates.ts`
- Grammar/equations: `packages/services/src/ingestion/grammar.ts`, `equations.ts`
- Promotion: `packages/services/src/knowledge/promotion.ts`
- Cleanup/re-extract: `packages/services/src/knowledge/cleanup.ts`
- IPC/main process pipeline: `apps/desktop/src/main/index.ts`
- Candidate UI: `apps/desktop/src/renderer/src/components/CandidateReview.tsx`
- Concept detail/challenge/source tabs: `apps/desktop/src/renderer/src/components/DetailPane.tsx`
- Source preview/PDF page anchoring: `apps/desktop/src/renderer/src/components/PdfViewer.tsx`
- Sources import/sidebar: `apps/desktop/src/renderer/src/components/SourcePane.tsx`
- Review queue: `apps/desktop/src/renderer/src/components/ReviewQueue.tsx`
- Profile/background/XP display: `apps/desktop/src/renderer/src/components/ProfilePane.tsx`,
  `apps/desktop/src/renderer/src/App.tsx`
- Candidate CRUD panels: `apps/desktop/src/renderer/src/components/candidates/panels.tsx`
- Constellation Map + hub rail: `apps/desktop/src/renderer/src/components/ConstellationMap.tsx`
- Hubs management tab: `apps/desktop/src/renderer/src/components/HubsPane.tsx`
- Concept list + select mode/tags: `apps/desktop/src/renderer/src/components/ConceptPane.tsx`
- User notes + note→highlight link: `apps/desktop/src/renderer/src/components/UserNotesSection.tsx`
- Constellation editor: `apps/desktop/src/renderer/src/components/WhereItReappearsEditor.tsx`

## Parser Versioning

Bump versions in `packages/services/src/core/version.ts` after behavioral
changes that affect repeatability:

- `PARSER_VERSION`: candidates/topic scoring/promotion-output behavior
- `GRAMMAR_VERSION`: grammar/equation extraction behavior
- `LAYOUT_VERSION`: segmentation/layout classification behavior
- `CHUNKER_VERSION`: retrieval chunk boundaries (`ingestion/chunker.ts`)

Candidate rows and parse runs stamp these versions for auditability.

## Data/Behavior Invariants

- `concept_candidates`, relation/equation/misconception candidates, and
  `semantic_chunks` are derived and safe to wipe on re-extract.
- Re-extract preserves promoted concepts with non-empty `evidence_json` and
  concepts with study history in `evidence_records`.
- Promotion is pure DB upsert and idempotent on `(source_id, slug)`.
- Promoted candidate evidence is snapshotted into `concepts.evidence_json`.
- LLM topic-filter decisions are stored as normalized terms in
  `sources.llm_filter_keep_terms_json`; the old `*_ids_json` column is mirrored
  for compatibility and backfilled on read.
- Candidate bulk-promote must stay conservative: strong `final_score`, no
  suspicious labels, and either definition support, strong typography support,
  or repeated domain-term evidence. Do not use old confidence-only gates for new
  parser rows.
- Equation candidates should stay attached to the nearest concept/section path
  whenever possible; unattached equations are a fallback state.
- Relation, misconception, and equation candidates support add/edit/delete from
  Candidate Review. Keep these controls renderer-only unless the underlying CRUD
  contract changes.
- PDF annotation rows use soft delete/restore semantics for undo where
  available. Do not hard-delete user annotations unless explicitly requested.
- Deferred-delete (source delete, concept bulk delete) must FLUSH on unmount,
  not cancel. The pattern: optimistically remove from the list, start a 5s
  timer that performs the real IPC delete, and on component unmount commit any
  still-pending deletes. Cancelling on unmount silently strands the row in the
  DB (deleted in UI, alive in DB → orphaned concepts/map).
- A highlight and its derived evidence span stay in sync both ways: creating a
  highlight adds a `highlight`-kind span carrying its `annotationId`; deleting
  either side removes the other and clears any note linked to that highlight.
  The rail renders highlight-evidence color by `annotationId` lookup (stable
  across description edits), falling back to page+quote match for legacy spans.
- User-authored notes and profile data are user-owned. Do not overwrite them
  during extraction, enrichment, or UI refresh.
- Review queue rows must be refreshed/removed immediately after concept delete
  or evidence-history changes.
- Deleting an evidence record recomputes derived state for that concept: the
  XP winner for the affected (concept, task kind) bucket is re-awarded to the
  next-highest-difficulty surviving attempt, and mastery is recomputed as
  `MAX(compression_stage)` of remaining records (the mastery row is removed
  when none remain → Unseen). Never leave XP stranded or mastery frozen on a
  deleted attempt's value.
- Concept rename updates `concepts.name` only; never change `slug` (promotion
  idempotency depends on `(source_id, slug)`).
- All renderer delete buttons render `×`, never the word "Delete", and carry a
  descriptive `title`. Standalone Cancel buttons that sit beside a primary
  action also render `×` (the `+ Add` toggles stay as text triggers).
- Background customization accepts video (`mp4`/`webm`) and images; video
  backgrounds render via `<video autoplay muted loop playsinline>`.

## Current UX Notes

- Candidate Review has bucket/tag/min-score filters, an LLM-kept toggle chip,
  manual ChatGPT topic filtering, configured API filtering inside the LLM
  topic-filter modal, and conservative bulk promotion.
- Relations, Misconceptions, and Equations candidate tabs use shared glass
  controls. Adding opens a centered `EditorModal` overlay; row edit stays inline.
  Row delete and editor cancel are `×` buttons (the `RowButton` `danger` variant
  renders `×`).
- Source preview is available beside all concept tabs (toggled by the Source
  button; the legacy in-tab Source tab was removed), can be resized/zoomed,
  has an evidence rail, and must preserve logical page position through tab,
  rail, and width changes. The viewer renders all pages in one continuous
  vertical scroll (no Prev/Next paging), fits page width with − / % / + zoom,
  exposes a selectable/copyable text layer per page, and auto-scrolls to the
  first evidence page on open.
- PDF source preview supports concept-scoped highlights and sticky notes.
  Highlight overlays must not block text selection; sticky note position must
  persist after drag/remount.
- The concept title in the DetailPane header is click-to-rename (display name
  only; slug stays stable so promotion idempotency on `(source_id, slug)`
  holds). The header also shows evidence-kind chips next to the importance tag.
- Constellations are cross-source: the Overview typeahead links a concept to
  any promoted concept across all sources (suggestion rows show the other
  source's filename). The list is user-curated only — enrich, the ChatGPT
  paste flow, and the generated prompt never write it.
- Regenerate RETIRES graded tasks (`evidence_tasks.retired_at`, migration 0035;
  `retireTasksForConcept`) and hard-deletes only unattempted ones.
  `evidence_records.task_id` is `ON DELETE CASCADE` with FKs enforced, so the
  old hard delete wiped the concept's graded history — never call
  `deleteTasksForConcept` for a "replace tasks" flow. `listTasksByConcept`
  hides retired tasks. Task generation is adaptive (contract 1.4.0): once a
  concept has graded attempts, `buildLearnerHistoryBlock` appends last/best
  stage, recent gaps, misconceptions, and calibration so the 5 tasks target
  them.
- Regenerating Challenge tasks excludes every already-seen prompt (live tasks
  + every `task_prompt_snapshot`), sends them as an AVOID list with a twist
  instruction, and post-filters exact normalized duplicates. The Regenerate
  control is a refresh-icon button that spins while generating (reduced-motion
  aware), not a text button.
- The grader always returns a non-empty `gaps_detected`, even on `understood`
  — framed as the next-stage step.
- The Review Queue header has a sort-cycle button (default → importance →
  stage, persisted in localStorage); there is no Refresh button (refetch is
  event-driven via the `starcall:review-queue-stale` window event). It lists
  ALL concepts with their due state; default sort is due-order (brand-new →
  most-overdue → soonest-future → centrality → importance → recency). Each row
  shows a due badge (`new` / `due now` / `overdue Nd` / `due in Nd`) and a clock
  ⏰ button opening a glass reschedule popover (preset chips 1d/3d/1w/2w/1mo +
  amber "Reset (due now)"; persists via `review:setDue`, updates the badge in
  place without hiding the row), plus `✓ Done` and the `×` delete. On open, only
  the most recently previewed source's group is expanded.
- The top-level source tab defaults to Candidates on first launch and
  remembers the last pick.
- Review queue rows are grouped by source/book with collapsible headers and
  quiet inline delete/undo behavior.
- Concept Overview supports manual concept fields, equations, constellations,
  and user notes. LLM population should not auto-create constellations.
- Profile owns display name, avatar, XP/challenge stats, a GitHub-style
  challenge-activity heatmap (53 weeks; per-day hover tooltip with a per-source
  breakdown), a challenges-by-source bar chart, background image/video, and
  background opacity. `StudyProgress` carries `source_counts` and
  `daily_activity` (with per-source counts). A level-up fires a supernova
  overlay and the header XP chip pulses on XP gain (both reduced-motion aware).
  Panels, the side tab, and the opacity slider are translucent over the
  configured background.
- `+ PDF` supports multi-select import. `+ Text` opens a centered large glass
  overlay for long pasted notes/articles/transcripts.
- The DetailPane header carries user tags beside the importance pill: a `+ tag`
  picker (existing tags or create-new with a color), each tag chip removable on
  hover (`×`). The auto evidence-kind chips are dismissible per concept.
- The Hubs tab (top-level, beside Map) is the home for hub management: create,
  inline rename/recolor/description, member removal (`×` chips), delete. It is
  independent of any source view, so orphaned hubs are manageable.
- The concept Select-mode toolbar is `[select-all] · N selected · Add to ▾ · ×`
  (delete). No Done button — Esc exits, and navigating away clears selection.
  Bulk delete shows a 5s "Undo" toast.
- Source preview has a find box (filter to matching pages on PDF, inline match
  highlight on text) and a "related pages only" toggle.
- The constellation editor's reason field is an evidence selector over the
  linked concept's spans (resolving to a linked note when present), not a
  free-typed relationship phrase.
- Most text inputs/selectors are translucent over the configured background
  (map selector/search, overview fields, notes, candidate search, profile
  name); custom dropdown option hover uses the shared `.rel-opt` purple.

## LLM Provider Notes

All provider calls go through `chatJSON(config, request, passName)` in
`packages/services/src/core/llm.ts`.

- Providers: `groq`, `anthropic`, and `local` (any OpenAI-compatible server —
  Ollama/llama.cpp/LM Studio — via `fetch` to `{localBaseUrl}/chat/completions`,
  default `http://127.0.0.1:11434/v1`; free-text `localModel`, one model for
  every pass, no API key; `MODEL_CHOICES.local` is empty). Local calls send
  `reasoning_effort: "none"` (thinking models otherwise burn max_tokens on
  hidden reasoning and return truncated JSON), retrying once without it on a
  400. Settings → "Test connection" lists models via `llm.listLocalModels`.
  The local provider is unrelated to the URL importer's SSRF guard
  (`net_guard` still blocks loopback for `+ URL`).
- Settings: provider, API keys, `heavyModel`, `lightModel`, `extractionMode`
- Heavy passes: `enrich`, `chunker`, `concepts`, `misconceptions`, `tasks`,
  `lazy_tasks`, `grader`
- Light passes: `structure`, `graph`
- Model names are validated against `MODEL_CHOICES[provider]`.
- Per-pass overrides (`modelOverrides`) are set in Settings → Model →
  "Per-pass models" (Groq/Anthropic only; local uses one model). Keys are
  limited to `OVERRIDABLE_PASSES` by `sanitizeSettingsInput`; an override not
  in the current provider's roster is ignored at resolve time.
- Groq `max_tokens` is capped to fit free-tier constraints.
- The configured candidate topic-fit API path must stay small enough for low
  Groq TPM tiers. Prefer small batches and compact prompts over sending the full
  candidate list. The manual ChatGPT prompt remains the large-list fallback.
- Anthropic JSON mode: structured passes (`chatStructured`: grader,
  lazy_tasks, enrich_concept, prereq_suggest) force a single tool with the Zod
  schema as `input_schema`; plain `chatJSON` callers (extraction passes, topic
  filter) still rely on prompt instruction + fence stripping.

## Skills/Agent Workflow

Use the current repo guide first, then choose the smallest relevant skill/tool:

- For normal code work: inspect with `rg`/file reads, edit with patches, run the
  smallest useful verification.
- For frontend changes: follow the existing dense desktop UI style; do not turn
  this into a marketing/landing page. Verify locally with the browser plugin
  when changing visible behavior.
- For spreadsheet/document/presentation artifacts: use the matching enabled
  skill/plugin instead of hand-rolling file formats.
- For image generation/editing: use the imagegen skill only when a bitmap asset
  is actually needed.
- For OpenAI product/API questions: use the OpenAI docs skill and official docs.
- For new reusable workflows or tool integrations: use the skill/plugin creator
  skills only when explicitly asked.

Do not invent broad abstractions unless they match the existing repo shape.
Prefer local patterns and narrow changes.

## Commands

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm -C packages/services build
pnpm -C packages/shared build
pnpm -C apps/desktop dev
```

After editing `packages/services` or `packages/shared`, rebuild those packages
before restarting Electron because electron-vite consumes their `dist/` output.

## Verification Expectations

- Parser/grammar/repo changes: run `pnpm test` when available.
- Cross-package type/API changes: run `pnpm typecheck`.
- Frontend visible changes: run the app and inspect the relevant screen.
- LLM/provider changes: prefer unit tests around config/parsing boundaries; avoid
  live API calls unless explicitly needed.

If `pnpm` or dependencies are unavailable, state that clearly in the final
response and still report what was changed.

## Historical Docs

`PLAN.md` is historical background. It mentions old choices such as
`better-sqlite3`, Zustand/TanStack Query, Drizzle, CLI-first flows, and broader
screens that are not the current implementation. Do not treat it as active
architecture unless a detail has been reconciled with `ARCHITECTURE.md` and the code.
