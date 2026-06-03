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
- Promoted concepts can be manually added/edited/deleted and attached to an
  existing source. Adding a concept opens a centered glass modal overlay (not an
  inline sidebar form). Review queue concepts are grouped by source and
  collapsible.
- Constellations (`where_reappears`) are user-curated ONLY. Enrichment and LLM
  extraction never write them (the full-extraction persist forces `[]`);
  migration 0020 cleared legacy LLM-generated links. Links store `{ name, reason }`
  (legacy bare strings still load); the reason is required on add.
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
  `packages/services/src/knowledge/srs.ts`. The queue defaults to expanding only
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
  `ExportConceptArgsSchema`. Single-concept only for now (source/library export
  is a planned extension).
- Star Hubs are shipped: named/color-coded cross-source concept groups
  (`star_hubs` + `star_hub_members`, migration 0019). Members are added via
  Select-mode multi-select in `ConceptPane` ("Add to ▾"; the old in-pane "+ Hub"
  create form was removed — creation now lives in the Hubs tab). Hubs render as
  Map nebula clusters. There is a dedicated top-level **Hubs tab**
  (`HubsPane.tsx`) for full management: create (random default color),
  rename/recolor/describe, remove members, delete. The Map rail lists ALL hubs
  (dimming ones not on the current source) so a hub whose source was deleted is
  still deletable. New-hub default color is randomized. Still planned: member
  roles, nesting.
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
  (PDF) or highlights matches inline (text source). "Related pages only" (was
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

- Providers: `groq` and `anthropic`
- Settings: provider, API keys, `heavyModel`, `lightModel`, `extractionMode`
- Heavy passes: `enrich`, `chunker`, `concepts`, `misconceptions`, `tasks`,
  `lazy_tasks`, `grader`
- Light passes: `structure`, `graph`
- Model names are validated against `MODEL_CHOICES[provider]`.
- Groq `max_tokens` is capped to fit free-tier constraints.
- The configured candidate topic-fit API path must stay small enough for low
  Groq TPM tiers. Prefer small batches and compact prompts over sending the full
  candidate list. The manual ChatGPT prompt remains the large-list fallback.
- Anthropic JSON mode is emulated by prompt instruction and fence stripping.

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
