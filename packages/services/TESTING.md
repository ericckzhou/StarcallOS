# Testing Strategy

`packages/services` is the evidence engine and has no DOM or Electron dependencies, so all tests run in plain Node via Vitest.

## What is tested

| File | Tests | Coverage focus |
|------|-------|----------------|
| `core/infra/migrate.test.ts` | 4 | Per-migration transaction atomicity, rollback, idempotency, `onBeforeApply` hook |
| `core/settings.test.ts` | 18 | OS-backed encryption round-trip, legacy plaintext migration, codec unavailability fallback, `sanitizeSettingsInput` enum clamping |
| `ingestion/candidates.test.ts` | 38 | Multi-signal confidence stacking, typography scoring, definition patterns, deduplication, caption/ToC detection, running-header normalization |
| `ingestion/layout.test.ts` | ~15 | Heading/subheading detection, font-size ratio, isolation, ALL-CAPS, caption downgrading |
| `ingestion/section_path.test.ts` | ~10 | In-body vs running-header provenance, strong-heading gating, mixed-source tagging |
| `ingestion/enrichment.test.ts` | 10 | `runEnricher`: block_type validation (invalid→hint prior), malformed/truncated JSON recovery, multi-batch splitting, pass name |
| `ingestion/grader.test.ts` | 16 | `parseGradeResult`: invariants, all score/stage values, non-object input; `gradeResponse`: call shape, temperature, `gaps_detected` never empty |
| `ingestion/pdf.test.ts` | 12 | `pageTextFromItems`: EOL handling, 1-based indexing, empty page; `pagesFromFormFeeds`: splitting, consecutive FF, leading/trailing FF |
| `knowledge/promotion_cleanup.test.ts` | 5 | Candidate promotion, cleanup preservation (studied vs LLM concepts), user-data retention |
| `knowledge/repos/concepts.test.ts` | 10 | Prefix search, cross-source isolation, wildcard escaping, limit enforcement |
| `knowledge/repos/concept_notes.test.ts` | 6 | Note CRUD, position ordering, cascading deletes |
| `knowledge/repos/pdf_annotations.test.ts` | 5 | Highlight/note creation, soft-delete/restore, coordinate updates |
| `knowledge/repos/parse_runs.test.ts` | 1 | CONTRACT_VERSION stamping on parse runs |
| `knowledge/repos/sources.test.ts` | ~4 | LLM topic-filter persistence, legacy migration |
| `knowledge/repos/star_graph.test.ts` | 4 | Graph building, edge deduplication, dangling link detection |
| `core/infra/db.test.ts` | 1 | In-memory DB smoke test (migrations + event round-trip) |

**Total: 16 test files, ~118 tests.**

## Known gaps

These paths have no test coverage. Listed in priority order.

### High — product correctness risk

- **`ingestion/extraction.ts`** — LLM-based section hierarchy extraction, lazy task generation, equation attachment. JSON parse failures here silently return `[]`.
- **`ingestion/lazy_tasks.ts`** — Task generation from concepts; prompt construction; deduplication of already-seen prompts.
- **`ingestion/enrich_concept.ts`** — Per-concept enrichment; JSON validation of LLM output.
- **`core/llm.ts`** — Provider config resolution, token budget accounting, `chatJSON` call shape. Currently tested only indirectly via `grader.test.ts` and `enrichment.test.ts`.

### Medium — repo-layer edge cases

- **`knowledge/repos/candidates.ts`** — Candidate read/write/bulk-delete paths.
- **`knowledge/repos/evidence.ts`** — Evidence submission, XP winner recalculation, mastery recompute after delete.
- **`knowledge/repos/star_hubs.ts`** — Hub CRUD, member add/remove.
- **`knowledge/repos/cleanup.ts`** — Re-extract preservation rules (tested only via integration in `promotion_cleanup.test.ts`).

### Low — I/O boundary

- **`ingestion/pdf.ts` (`parsePdf`)** — File read + `pdf-parse` orchestration. The page-render callback and form-feed fallback are now tested via extracted helpers; the full I/O path is not.
- **Desktop renderer components** — Only `candidates/shared.test.ts` (3 cases) covers the renderer. No IPC integration tests or E2E tests exist.

## Running tests

```sh
# All packages
pnpm test

# Services only (fast, no Electron)
pnpm -C packages/services test

# Watch mode
pnpm -C packages/services test:watch
```

## Adding a test

1. Place the file next to the source: `src/ingestion/foo.test.ts` alongside `src/ingestion/foo.ts`.
2. Use an in-memory SQLite DB for any repo tests (`new DatabaseSync(':memory:')` + `runMigrations`).
3. Mock `chatJSON` via `vi.mock('../core/llm', ...)` for any LLM-dependent code — do not make live API calls in tests.
4. Next migration number is `0025_` (two files share the `0011_` prefix intentionally; do not reuse it).
