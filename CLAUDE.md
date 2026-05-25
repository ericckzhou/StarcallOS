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
- User-facing provider text should say "configured LLM provider" unless a
  feature is truly Groq-specific.
- `ARCHITECTURE.md` may be untracked in this workspace; do not remove or overwrite it.
- `pnpm` may not be on PATH in this shell. If verification cannot run, say so
  plainly instead of implying tests passed.
- PowerShell may render UTF-8 box drawing and arrows as mojibake. Do not treat
  that display artifact as proof that the source file is corrupted.

## Current Product Shape

StarcallOS is an Electron desktop app for turning PDFs/text sources into
evidence-backed ML/AI learning loops. It is not chat-with-PDF and not a generic
summarizer.

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
- Candidate bulk-promote must stay conservative: high confidence, sufficient
  mentions/topic relevance, and no suspicious/broad/boilerplate flags.

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
