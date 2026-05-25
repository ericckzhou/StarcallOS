# StarcallOS — Implementation Plan

> **Historical note:** this plan records an earlier product/architecture
> direction and is not the source of truth for the current codebase. The current
> implementation uses the candidate-first Electron app described in
> `ARCHITECTURE.md`: Node built-in `node:sqlite`, no `better-sqlite3`, no Drizzle,
> no Zustand/TanStack Query layer, no CLI app, and no Python in the critical
> path. Treat details below as background only unless they have been reconciled
> with the current code.

> **Status:** plan, not committed. WAITING FOR CONFIRMATION before Phase 0.
> **Last revised:** 2026-05-23 (rev 2 — GUI direction)

---

## Product thesis

**Claims of durable, transferable understanding need evidence — and the evidence must survive translation, compression, and time.**

StarcallOS is a **local-first learning-evidence system** with a **GUI for inspection/review** and an **optional CLI for focused test/revise flows**. It prevents self-deception about AI/ML mastery by forcing every "understood" claim to be backed by:

1. An explanation in the user's own words
2. A passing AI critique of that explanation
3. A persisted attempt lineage showing how understanding evolved
4. Evidence of *transfer* (apply to novel context), *compression* (explain at multiple abstraction levels), and *calibration* (predicted vs. actual score)

End goal: ship a tool the user actually uses while preparing for falsifyai work, so concepts like *embeddings, attention, RAG, evals, drift* become genuinely owned, not vaguely familiar.

**Why GUI-first:** sources, attempt timelines, misconception history, and concept maps are evidence artifacts — and evidence is visually easier to inspect than to scroll through in a terminal. The CLI remains the discipline surface (test, revise, due, review); the GUI is the evidence surface (sources, history, maps, misconceptions, progress, reading).

---

## Philosophical lens (load-bearing)

Borrowed and adapted from `falsifyai/dev_notes/plans/lineage.md`. **StarcallOS is a recoverable epistemic operating system for personal cognition.** "Evidence infrastructure" was the earlier framing; the sharper one is *recoverable* — the system's authority comes not just from collecting evidence, but from making the chain of belief replayable. A user should always be able to ask "why does the app think I understand this, and what evidence changed that belief?" and get an inspectable answer assembled from append-only records.

This framing is what prevents drift into flashcards, PKM, AI tutoring, or generic note-taking. None of those are recoverable. None of them treat belief as something whose evolution must be replayable.

| FalsifyAI | Lineage | **StarcallOS** |
|---|---|---|
| Claims about AI behavior need evidence | Claims about architecture need evidence | **Claims about understanding need evidence** |
| Replay artifact = inspectable proof | Lineage chain = inspectable proof | **Attempt lineage = inspectable proof of comprehension growth** |
| Resolver inflation is anti-pattern | Knowledge-graph inflation is anti-pattern | **Grading-rubric inflation is anti-pattern** |
| Diverse perturbation categories | Diverse evidence types | **Diverse test modes (transfer, no-jargon, compression, comparison)** |

### Concrete consequences

- **No-evidence = no-claim.** A concept cannot become `understood` without a passing attempt. No "I just know this" shortcut.
- **Compression over enumeration.** CLI shows one verdict + one follow-up. GUI shows one screen per question (claim / evidence / next). SQLite preserves everything.
- **The grader is the resolver.** It must stay predictable. A competent user reading their own answer should anticipate the score. If they can't, the grader has become a black box.
- **Three-layer separation:**
  - *Evidence generation* — user explanation, source notes, confidence-before-scoring
  - *Evidence interpretation* — grading rubric, status thresholds, review scheduler, trajectory signal
  - *Evidence preservation* — SQLite (attempts immutable, append-only)
- **Graph is implementation detail.** `starcall map` / the Concept Map screen are presentation surfaces, not browsable infinite-graph explorers.
- **Misconception extraction is advisory, not authoritative.** Misconceptions require explicit contradictory evidence in the user's text; missing detail is omission, not false belief.
- **Source-backed but not source-dependent.** Sources can *support* learning and provide context, but they cannot *prove* understanding. Only user-generated explanations and tests prove understanding. The GUI source library is evidence of input; the attempt lineage is evidence of comprehension. These must not be conflated.
- **Grader source-metadata is contextual, never authoritative.** The grader sees source titles, types, and the user's takeaway notes at grade time — never raw source content, embeddings, or similarity scores. The metadata helps the grader calibrate the user's frame of reference; it does not become a ground-truth check. Anti-mimicry instructions in the grader prompt protect against rewarding lexical echo of takeaway notes. The metadata snapshot is frozen into the attempt for replay. *Starcall evaluates internalized understanding, not citation fidelity.*
- **Every GUI screen answers exactly one of three questions:** (1) What do I claim to understand? (2) What evidence supports that claim? (3) What should I study or test next? Screens that don't pass this gate are scope drift toward an Obsidian clone.
- **Process boundary is a trust boundary.** In the Electron shell, the renderer is treated as untrusted code. SQLite, the Anthropic API key, the file system, and the grader prompt all live in the main process. The renderer only sees a narrow, typed `window.starcall.*` surface exposed by `contextBridge`. The architectural rule "no business logic in transport layers" generalizes: no business logic in IPC handlers, no business logic in CLI commands, only in `services/`. This is the same separation the prior FastAPI direction had — the only thing that changed is the transport.
- **Evidence-first UX.** Every derived statement in the GUI must answer *why does the system believe this?*, not only *what does it believe?* A maturity badge has a tooltip showing the latest standard score, the latest transfer attempt, and any unresolved misconceptions. A trajectory chip is clickable to the attempts that produced it. A "due for review" entry is clickable to the trajectory or schedule that triggered it. If a screen shows a derived conclusion without a path back to its evidence, it has failed the philosophy.
- **Lineage is derived, never authoritative. Events are the source of truth.** `core/events.ts` is the append-only ledger of what happened. State-changing operations emit through services into the ledger; explanatory views (timelines, transitions) are *read-only assembly* over it. V1 starts with a simple per-concept attempt timeline in `artifacts/attempts/timeline.ts` — a dedicated `lineage/` layer is deferred until real usage proves the need for cross-source / cross-misconception narrative assembly. The principle holds even though the layer doesn't exist yet: nothing is ever allowed to *write* derived state.

---

## Tech stack

**Form factor:** Electron desktop app (long-term daily cockpit), not a hosted web app. The earlier "FastAPI + React" web direction is superseded — Electron is a better fit because (a) the user already has the pattern from a prior Electron project, (b) the app must work fully offline against a local SQLite file, (c) Anthropic API keys must live in a trusted process the user owns, not in a renderer, and (d) treating this as a packaged binary forces a tight scope.

**Language decision (locked 2026-05-23):** TypeScript/Node end-to-end. The prior Python rationale only mattered if StarcallOS needed to share code with FalsifyAI, which it doesn't — StarcallOS shares the philosophy, not the implementation. Since this is Electron-native, TS gives one toolchain across renderer, preload, main, IPC contracts, DTOs, zod schemas, tests, and packaging. **No Python sidecar in V1.** A sidecar would add process management, packaging complexity, IPC surface area, and failure modes before the product has earned them. Python remains a candidate later for a specific isolated subsystem (local ML, embeddings pipeline, heavier offline analysis) — but never in the V1 critical path.

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node 20+ in Electron main; browser env in renderer | Modern, secure defaults |
| Language | TypeScript end-to-end | One toolchain across main/preload/renderer/services/CLI |
| Shell | Electron (latest stable) with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` | Secure-by-default renderer; renderer is treated as untrusted code |
| Renderer framework | React 18+ + Vite (via electron-vite or Electron Forge Vite template) | Fast local dev loop; user familiarity |
| Renderer state | Zustand | Lightweight, ergonomic, no boilerplate; isolates per-screen state without prop drilling |
| Server state in renderer | TanStack Query over the IPC client | Caching, refetch-on-focus, optimistic updates — same patterns as web, but the transport is IPC, not HTTP |
| Renderer styling | Tailwind + a small headless-UI primitive library (Radix or similar) | Editorial restraint over template aesthetic; see global web rules |
| IPC | `contextBridge` + `ipcRenderer.invoke` (promise-based), typed via a shared types package | Narrow attack surface; renderer only ever sees a typed `window.starcall.*` API |
| Storage | SQLite via `better-sqlite3` (main process only) | Synchronous, fast, single-file local-first DB; never imported in the renderer |
| Migrations | Hand-rolled SQL migrations runner OR `umzug` | Minimal, no ORM dependency |
| Query layer | Drizzle ORM (TS-first, typed) — or Kysely if pure query builder preferred | Type-safety to the DB without runtime overhead |
| LLM | `@anthropic-ai/sdk` (called from main only) | Haiku 4.5 for grading; Sonnet 4.6 for `ask` synthesis |
| Schema validation | zod | Structured grader output parsing, IPC request/response validation |
| Optional CLI | `commander` (or `cac`) — added in Phase C0 | Power-user surface for `test`/`revise`/`due`/`review`; imports the same services package |
| Tests | Vitest (services + main + renderer); React Testing Library (renderer); Playwright + Electron driver (E2E, critical flows only) | One runner across the stack |
| Packaging | pnpm workspaces; Electron Forge (or electron-builder) for distributables | Workspace separation between `services/`, `shared/`, `desktop/`, `cli/` |
| Lint/format | eslint + prettier | One toolchain |
| LLM-call recording | A tiny recorded-cassette layer over `@anthropic-ai/sdk` (intercept at `fetch`/SDK middleware) | Deterministic tests; integration tests hit real API behind `STARCALL_REAL_LLM=1` |

### Process-boundary discipline (the load-bearing rule)

```
Renderer (React + Zustand)
       │      ❌ no SQLite, no @anthropic-ai/sdk, no secrets, no fs
       │      ✅ only typed window.starcall.* exposed by preload
       ▼
Preload (contextBridge)
       │      ✅ exposes a narrow, typed API surface; no Node globals leaked
       ▼
IPC channel (ipcRenderer.invoke ↔ ipcMain.handle)
       │      ✅ every channel name and payload shape lives in packages/shared
       ▼
Main process (Node)
       │      ✅ owns SQLite (better-sqlite3), API keys (from OS keychain or .env),
       │         Anthropic SDK, file system access, logging
       │      ✅ thin handlers call services/ — never inline business logic
       ▼
services/ package (pure TS, no Electron imports)
       │      ✅ the only place business logic lives
       │      ✅ also imported by the optional CLI in-process
       ▼
core/ (domain · infra · resolver) + evaluation/ + knowledge/ + artifacts/
```

**Architectural rule:** the Electron main process and the Typer-style CLI are two thin transports over the same `services/` package. No business logic in IPC handlers, no business logic in CLI commands. The renderer never imports anything from `services/` directly — it only consumes the IPC-exposed surface. This is the same separation the prior web-app plan had, just with a process boundary instead of an HTTP boundary.

LLM calls are mocked in unit tests via recorded cassettes. Integration tests hit real API behind `STARCALL_REAL_LLM=1`.

---

## Project structure

The biggest structural shift from the prior plan: this is now organized as a *cognition evidence platform*, not a CLI tool. The layout names the layers explicitly — `interfaces`, `services`, `evaluation`, `knowledge`, `artifacts`, `resolver`, `infra` — rather than collapsing them into `core/` + `grader/` + `cli/`. The renaming is load-bearing: each layer has a single responsibility and a single direction of dependency (interfaces depend on services, services depend on knowledge + evaluation + artifacts, all depend on core).

```
StarcallOS/
  packages/
    services/                       # the cognition evidence layer — pure TS, no Electron imports
      src/
        core/
          domain/                   # business meaning — entities + invariants only
            concepts.ts
            attempts.ts
            misconceptions.ts
            reviews.ts
            edges.ts
            sessions.ts             # learning-session aggregate
          events.ts                 # the append-only ledger — one file for V1; promote to a folder when real usage demands it
          infra/                    # infrastructure concerns
            db.ts                   # better-sqlite3 connection (main-process-only)
            settings.ts
            logging.ts
            keychain.ts             # OS-keychain wrapper for API key storage
            migrations/             # versioned SQL migration files
          resolver/                 # interpretation, no I/O
            scoring.ts              # sum sub-scores → final score
            thresholds.ts           # score → core status
            trajectory.ts           # stable / improving / decaying
            maturity.ts             # derived label: unseen | learning | understood | durable
            evidence-strength.ts    # derived signal — recency × transfer × misconception × calibration × trajectory
        evaluation/                 # was `grader/` — broader scope: prompts + schemas + modes + calibration
          prompts/
            standard.ts             # versioned prompt strings
            transfer.ts
            no-jargon.ts
            compress.ts
            compare.ts
          schemas/                  # zod schemas for grader output
            verdict.ts
            mode-result.ts
          modes/
            index.ts                # mode dispatcher
          grader.ts                 # Anthropic call + structured-output parsing (main-process-only)
          calibration/              # known-good + known-bad fixtures (run in CI)
        knowledge/                  # consolidates concepts + sources + graph + misconceptions
          concepts/
            commands.ts             # add/update operations
            queries.ts              # list/show/filter
          sources/
            commands.ts             # add/attach
            excerpts.ts             # source_excerpts (see Data model)
            reading.ts              # reading-mode takeaway capture
          graph/
            edges.ts                # link/unlink/traverse — four fixed relations
            map.ts                  # build static map payload (presentation)
          misconceptions/
            tracker.ts              # upsert into misconceptions table
            normalize.ts            # exact-string normalization (V1 — see normalization risk)
        artifacts/                  # attempts as inspectable evidence + exports/reports
          attempts/
            capture.ts              # persist user_explanation, confidence_before, ai_feedback_json
            timeline.ts             # simple per-concept attempt timeline (V1 scope); promotes to a lineage/ layer only when real usage demands cross-source/cross-misconception narrative assembly
          exports/                  # markdown export, daily snapshots (post-V1)
        services/                   # the façade — both interfaces use ONLY these
          concepts.ts
          sources.ts
          attempts.ts               # capture explanation → dispatch to evaluation → persist artifact → emit event
          revisions.ts
          review.ts
          ask.ts                    # structured query over user state
          evidence.ts               # assemble source evidence panel payload
          reading.ts                # reading-mode flow
        seeds/
          ai-ml-pack.yaml           # 16 seed concepts + edges
        index.ts                    # public exports — the only surface other packages may import
      test/
        unit/
        integration/                # service-level tests against in-memory SQLite
        fixtures/
          cassettes/                # recorded LLM responses
          calibration/              # known-good + known-bad explanations
      package.json
      tsconfig.json
    shared/                         # IPC contracts + DTOs used across the process boundary
      src/
        ipc.ts                      # channel names, request/response shapes (zod)
        models.ts                   # DTO shapes the renderer is allowed to know about
      package.json
      tsconfig.json
  apps/
    desktop/                        # the Electron app — `interfaces/desktop`
      electron/
        main.ts                     # app lifecycle, BrowserWindow, IPC registration
        preload.ts                  # contextBridge: exposes a single typed `window.starcall` object
        ipc/                        # thin handlers — call services, validate with zod, return DTOs
          concepts.ts
          sources.ts
          attempts.ts
          review.ts
          misconceptions.ts
          map.ts
          ask.ts
          reading.ts
      renderer/
        src/
          pages/                    # one folder per GUI screen (see GUI screens section)
            dashboard/
            concept/
            sources/
            test/
            timeline/
            misconceptions/
            review/
            map/
            next/
            reading/
          components/
            ui/                     # buttons, surfaces, animated text — see web rules
            evidence/               # source-evidence panel, attempt lineage, trajectory chip
            maturity/               # maturity badge (derived label, not core status)
          state/                    # Zustand stores (UI state only — server state stays in TanStack Query)
            useUiStore.ts
            useTestDraftStore.ts
          lib/
            api.ts                  # typed wrapper over window.starcall.*, integrated with TanStack Query
            format.ts
          hooks/
            useConcept.ts
            useReducedMotion.ts
          styles/
            tokens.css
            global.css
          main.tsx
        index.html
        vite.config.ts
      forge.config.ts               # or electron-vite config
      package.json
      tsconfig.json
    cli/                            # `interfaces/cli` — optional, added in Phase C0
      src/
        index.ts                    # commander entry
        commands/
          test.ts                   # starcall test <concept> [--mode ...]
          revise.ts                 # starcall revise <concept>
          due.ts                    # starcall due
          review.ts                 # starcall review
        render/                     # terminal rendering helpers (chalk / cli-table3)
      package.json
      tsconfig.json
  data/                             # gitignored — user's local starcall.db (resolved via Electron `app.getPath('userData')` in prod)
  pnpm-workspace.yaml
  package.json                      # workspace root
  README.md
  PLAN.md                           # this file
  .gitignore
```

**Why this shape (the layer-by-layer rationale):**

| Layer | Single responsibility | Why named this |
|---|---|---|
| `core/domain` | Entities and invariants — what *is* a concept, attempt, misconception | Separates business meaning from any storage or framework concern |
| `core/events.ts` | The append-only event ledger — single file for V1 | Events are the source of truth for state transitions, but a single file is enough until real usage proves the need for a folder. Promote to `core/events/` only when bus / store / replay each warrant their own file. |
| `core/infra` | DB, settings, logging, keychain, migrations | Keeps infrastructure swappable; lets services be testable against in-memory SQLite |
| `core/resolver` | Pure interpretation: score sums, status thresholds, trajectory, maturity, evidence-strength | Resolver logic gathered in one place — easy to audit, easy to keep four-line, easy to prevent inflation |
| `evaluation` | Prompts, modes, grader call, calibration fixtures | Renamed from `grader/` because the system does *evidence interpretation, calibration, misconception analysis, and transfer testing* — broader than grading |
| `knowledge` | Concepts, sources, graph, misconceptions, source excerpts | Groups the "knowledge representation" subdomain; supports the GUI's evidence surfaces |
| `artifacts` | Attempts as inspectable evidence; per-concept attempt timeline; exports and reports later | Names the philosophical truth: attempts are not just rows, they are *evidence artifacts*. A dedicated `lineage/` layer is explicitly deferred — V1 lives with a simple `attempts/timeline.ts`. |
| `services` (façade) | The only surface that interfaces are allowed to call | Prevents IPC handlers and CLI commands from drifting into business logic |
| `interfaces` (`apps/desktop`, `apps/cli`) | Pure transport — IPC handlers and CLI commands only | Same separation as the FastAPI direction had; the Electron process boundary replaces the HTTP boundary |
| `shared` | Cross-boundary types (IPC contracts, DTOs) | Lets the renderer be strongly typed without ever importing services |

The CLI imports the services package directly (in-process, opens the same SQLite file via the same `core/infra/db.ts`). It does *not* spawn the Electron app or go through IPC. Both interfaces share the same engine — they just present different surfaces of it.

---

## Data model

```sql
concepts(
  id, name, slug,
  summary,
  why_it_matters,             -- MANDATORY at insert time; NOT NULL CHECK length(trim(why_it_matters)) > 0
  status,                     -- core status (the resolver's output)
  difficulty,
  created_at, updated_at
)

sources(
  id, title, type, url, author,
  notes,
  created_at
)

concept_sources(concept_id, source_id)

source_excerpts(             -- supports reading-mode and the source-evidence panel
  id, source_id,
  excerpt,                    -- the user's quoted/captured passage
  linked_concept_id,          -- nullable; an excerpt may be linked or unfiled
  takeaway_note,              -- the user's own-words takeaway (NOT evidence of understanding — see philosophy)
  created_at
)

sessions(                    -- a learning session — groups attempts into focused study windows
  id, started_at, ended_at,
  focus_area,                 -- free-text label, optional
  created_at
)

attempts(
  id, session_id,             -- nullable; attempts may exist without an explicit session
  concept_id, attempt_no, prompt_version, mode,
  mode_payload_json,          -- transfer prompt, jargon blocklist, compare-against
  user_explanation,
  confidence_before,          -- 0-100, captured BEFORE grading
  source_metadata_snapshot_json,  -- contextual-only snapshot of source metadata at grade time:
                                  -- [{source_id, title, type, takeaway_notes: [...]}, ...]
                                  -- NEVER includes raw source text. Stored for replay/reproducibility:
                                  -- "what study context did the grader see when it produced this verdict?"
  ai_feedback_json,           -- full structured grader output
  score,                      -- resolver output, summed sub-scores
  calibration_gap,            -- confidence_before - score
  status_after,
  follow_up_question,
  created_at
)
-- attempts is APPEND-ONLY. Never UPDATE. Revision = new row with attempt_no + 1.

mode_results(                -- per-mode score history (queryable evidence of transfer/no-jargon/compress/compare)
  id, attempt_id,
  mode,                       -- standard | transfer | no_jargon | compress | compare
  score, passed,              -- passed = score >= mode-specific threshold (transfer ≥ 70, etc.)
  payload_json,
  created_at
)
-- Denormalized for query speed; attempts.ai_feedback_json remains the source of truth.

edges(
  id, from_concept_id, to_concept_id,
  relation,                   -- prerequisite | related | example_of | used_in (four fixed, do not extend)
  created_at
)

reviews(
  concept_id, next_review_at, review_count,
  ease_factor, last_score
)

review_outcomes(             -- evidence of retention: how a review actually went
  id, concept_id,
  review_type,                -- scheduled | unscheduled | trajectory_triggered
  pre_review_confidence,      -- captured BEFORE the review attempt
  post_review_score,          -- the score on the review attempt
  retention_delta,            -- post_review_score - last_pre_review_score
  attempt_id,                 -- the attempt that satisfied this review
  created_at
)

misconceptions(
  id, concept_id, statement, severity,
  first_seen_attempt_id, last_seen_attempt_id, resolved_attempt_id,
  recurrence_count
)

events(                      -- append-only ledger of state transitions across the system
  id, type,                   -- concept_added | attempt_created | misconception_resolved | status_changed | review_completed | source_attached | takeaway_captured | ...
  entity_type, entity_id,
  payload_json,
  created_at
)
-- Events are the source of truth for state transitions. Foundation, not utility.
-- Written through core/events/event-store.ts (services emit, never the renderer or CLI).
-- Read through lineage/ to assemble belief-evolution narratives.
-- Downstream features (timeline diffs, undo, weekly snapshots, full event-sourcing) extend this layer rather than retrofit it.
```

**Hard rules:**
- `attempts` is append-only. Revisions are new rows.
- `events` is append-only. The system never deletes from `events`; state is recoverable by replay.
- `prompt_version` is stored on every attempt so rubric changes don't invalidate old scores.
- `ai_feedback_json` is the source of truth for grader output; `mode_results` is a denormalized read model derived from it.
- Misconceptions are tracked separately from `missing_points` (see false-positive risk below).
- `why_it_matters` is mandatory at concept-creation time. A concept without an operational answer to "why does this matter?" is not allowed in the system.
- `source_excerpts.takeaway_note` is evidence of *exposure*, not understanding. Only `attempts` count as evidence of understanding. This is the operational form of "source-backed but not source-dependent."

### Deliberately deferred (anti-inflation gate)

Structural additions that were considered across plan revisions and *deferred* to preserve the V1 compression discipline. These are preserved here as named candidates so that when V1 limits start binding, the decision to add them is conscious, not accidental. **Do not pre-build for any of these.**

#### Schema-level deferrals

| Deferred addition | Why deferred |
|---|---|
| `concept_aliases` (RAG / retrieval-augmented generation / retrieval augmented generation) | The V1 concept-identity rule is "slug from lowercased name, immutable." Aliases re-open the identity-resolution problem that the plan deliberately avoids until evidence accumulates. Revisit only after a real alias conflict appears in the user's data. |
| `edges.strength` (weak vs. strong prerequisite) | Currently the four-relation graph is intentionally flat. Adding a strength field invites edge-taxonomy inflation — exactly the failure mode the philosophy guards against. Dependency-failure detection works adequately with binary edges; revisit only if false positives become operationally annoying. |
| `clusters` / `cluster_concepts` (manual concept groupings) | Pure presentation concern; can be implemented in the renderer at first via local filters on `concepts.difficulty` or `concepts.status`. A schema table only earns its existence if multi-concept operations (batch test, batch review) demand it. |
| `claims` (extracted assertions inside an explanation — e.g. "embeddings encode meaning") | Claim extraction faces the exact normalization problem the plan already defers for misconceptions ("gradient descent minimizes loss" vs. "gradient descent finds the loss minimum" — same claim?), but harder. Either hand-curated taxonomies (curation overhead the user won't sustain) or LLM-extracted (semantic-clustering territory we've already chosen to defer). Revisit only if the misconception table demonstrably fails to capture what claims would. |
| `claim_support` / `claim_contradictions` (per-attempt claim coverage) | Pre-requires `claims`; same deferral. |
| `uncertainty_artifacts` (ambiguities, unsupported inferences, conflicts) | `confidence_before` + `calibration_gap` + `missing_points` already capture the load-bearing 80% of "what isn't supported." A dedicated uncertainty subsystem earns its place only if those three prove insufficient under real use. |
| `counterevidence` table | Already captured implicitly: failed attempts (score < 60) are counterevidence and live in the append-only `attempts` table. Resolved misconceptions are counterevidence to a prior belief. Don't duplicate. |

#### Layer-level deferrals

| Deferred layer | Why deferred |
|---|---|
| `lineage/` peer layer (events/transitions/timeline/replay/invalidations as a dedicated folder) | Considered and explicitly deferred 2026-05-23: adding 9 files for events + lineage before grading a single explanation violates the compression instinct. V1 starts with single-file `core/events.ts` + a simple `artifacts/attempts/timeline.ts`. Promote to a `lineage/` peer layer only when real usage demands cross-source / cross-misconception narrative assembly that the attempt timeline can't carry. The *principle* (lineage is derived, never authoritative) holds even without the folder. |
| `core/events/` folder (event-types / event-bus / event-store / replay split) | Same gate as above — promote `core/events.ts` to a folder only when bus / store / replay each warrant their own file. V1 doesn't. |
| `evaluation/lineage/` (grader-version + rubric-history + calibration-history folder) | `prompt_version` already lives on every attempt and `evaluation/calibration/` already exists. The invariant that matters — *regrading with a new prompt creates a new attempt, never mutates the old one* — is enforced at the service boundary, not by a folder. Revisit if grader-version diffing becomes a user-facing surface. |
| `evaluation/grounding/` (source-grounding coverage and unsupported-claim detection) | The V1 grader prompt already separates `missing_points` from `misconceptions` and can be asked to call out source-unsupported claims if the prompt evolves. A dedicated grounding subsystem is V2 — wait until claims are real. |
| `core/invariants/` (folder of named invariants) | Invariants belong as code-level guards next to the code they constrain (zod refinements, DB CHECK constraints, runtime asserts in services), not as a documentation folder. A folder of "invariant docs" tends to read as intent without enforcement. |
| `lineage/transitions.ts` as a *separate* primitive | Already covered: a transition is just an `event` with `type = status_changed` or similar. The `lineage/transitions.ts` *file* exists (it's a reader); we deferred the idea of transitions as a *new structural concept distinct from events*. |
| `core/time/` (recency, decay, intervals) | Time-aware signals are needed (review scheduler, trajectory windows, evidence_strength decay), but they live with the functions that use them. A dedicated time layer is premature until at least three call sites duplicate the same logic. |
| `resolver/recoverability.ts` (composite metric) | Interesting long-term primitive. V1 has no UX surface for it; would be a number with nowhere to render. Revisit when the GUI has a place that needs it. |
| `knowledge/compression/` (distilled causal summaries, reusable abstractions) | Speculative; no V1 user-facing question requires it. |
| `pages/` → `surfaces/` or `workflows/` rename | `pages/` is honest for nine discrete screens. Revisit if the GUI evolves toward multi-step workflows that span screens. |

#### What was considered and rejected outright (not "deferred" — *not coming*)

| Rejected | Reason |
|---|---|
| Splitting `core/resolver/` into `interpretation/` + `derivations/` | The split already exists conceptually (core status is DB-backed, derived signals are render-time-only). A folder split duplicates a separation that is already enforced by the events ledger and the resolver-inflation risk. |
| Splitting `artifacts/attempts/` into `explanations / evaluations / revisions / comparisons` | Revisions are `attempt_no > 1`; comparisons are `mode = compare`. The `mode` column already discriminates these. Pre-splitting them is exactly the ontology-explosion failure mode. |
| Renaming `packages/services` → `engine` or `knowledge` → `provenance` | User confirmed (2026-05-23) that the existing names read more intuitively. Keep `services/` and `knowledge/` as is. |

---

## Status & scoring (the resolver — must stay predictable)

Two layers, deliberately separated:

1. **Core status** — stored in DB, decided by deterministic resolver from latest standard-mode score.
2. **Derived maturity label** — computed at render time from multi-mode evidence. Never stored, never the source of truth.

### Core status (DB-backed, score-thresholded)

| Score (latest standard attempt) | Status |
|---|---|
| ≥ 80 | `understood` |
| 60–79 | `learning` |
| < 60 | `weak` |
| no attempts | `unseen` |
| was `understood` and `next_review_at < now` | `needs_review` |

Score breakdown (returned by grader, summed by resolver):

| Dimension | Weight |
|---|---|
| Correctness | 40 |
| Clarity | 20 |
| Example quality | 20 |
| Missing concepts | 10 |
| Misconceptions | 10 |

The LLM does **not** return the final verdict directly. That is resolver territory, not generation.

### Derived maturity (render-time only, four labels)

| Label | Requires |
|---|---|
| `unseen` | no attempts of any mode |
| `learning` | core status is `learning` OR `understood` without the multi-mode evidence below |
| `understood` | core status `understood` (latest standard score ≥ 80) **AND** at least one `transfer`-mode attempt with score ≥ 70 **AND** zero unresolved high-severity misconceptions |
| `durable` | `understood` (as above) **AND** passed at least one review-mode reattempt after a non-trivial delay (≥ 24h) with score ≥ 80 |

The point: a single high-scoring standard explanation is not enough to claim understanding. That is "I explained it once, so I know it" — the failure mode the system exists to prevent.

`durable` is the render-time-only state because durability is a property of *evidence accumulated over time*, not of a single attempt. Keeping it out of the core status table preserves the four-line resolver and prevents graduated-status inflation (`understood-1/2/3`, etc.).

Both layers are presented in the GUI: status drives behavior (review scheduling, dependency-failure warnings), maturity drives interpretation (the dashboard chip the user reads).

---

## Grader source-metadata policy

The grader is **content-blind to sources** but **context-aware about study material**. This is a load-bearing invariant — it preserves anti-mimicry and source-independence while making the grader's view of the user's study context inspectable.

### Allowed at grade time

The grader prompt receives a small, structured study-context block:

- Source **titles** of every source attached to the concept
- Source **types** (book / paper / article / video / note)
- The user's **takeaway notes** (the user's own typed words from Reading mode)

That snapshot is persisted into `attempts.source_metadata_snapshot_json` so every attempt is replayable with the exact study context the grader saw.

### Explicitly forbidden at grade time

- Raw source text (no PDF parsing, no HTML scraping, no transcript ingestion)
- Embeddings or vector similarity between explanation and any source
- Lexical similarity / coverage scoring against takeaway notes
- Contradiction checks against source documents
- Any retrieval system over source content

The moment any of these are introduced, V1 complexity explodes (claims primitives, grounding subsystem, vector infrastructure) and mimicry incentives appear. These are not just deferred — they are *prohibited* in V1.

### Required wording posture in the grader prompt

The prompt must frame source metadata as **contextual, not authoritative**. Example phrasing:

> *The user studied from the following sources and wrote the following takeaway notes. This is contextual only. Do not reward lexical similarity to the takeaway notes. Evaluate the user's explanation independently on conceptual correctness, clarity, examples, missing ideas, and misconceptions.*

The prompt must **not** say "grade according to these sources" or "check the explanation against the takeaway notes." The grader's verdict comes from the model's own knowledge of the concept; source metadata only helps it calibrate frame-of-reference ("this user is likely using the cookbook's framing of 'embeddings'") without ever becoming a ground-truth check.

### Why this earns its place

- **Grader contextual calibration** — the grader knows what framing the user has been exposed to and can spot when an explanation imports the right vocabulary but the wrong model.
- **Inspectability** — anyone reading an old attempt can see exactly what study context shaped the verdict.
- **Replayability** — re-grading an old attempt is reproducible because the metadata snapshot is frozen with it.
- **User trust** — the verdict isn't from a generic Claude call; it's from a Claude call with the user's named study context in view.
- **No new infrastructure** — ~30 extra tokens per grader call, one new column, one new paragraph in the prompt template.

### Anti-mimicry test (required predictability fixture)

The Phase 4 calibration fixture must include at least one paired case:
- Case A: explanation that paraphrases the takeaway note in different words
- Case B: explanation that repeats the takeaway note verbatim
Both cases must score within rubric-noise of each other. If Case B scores higher, the anti-mimicry instruction is broken and the prompt change is rejected.

---

## Grader prompt philosophy (Phase 4)

The grader prompt should reinforce:

- causal understanding over terminology recall
- anti-mimicry / anti-verbosity incentives
- explicit uncertainty over fabricated certainty
- demonstrated understanding over inferred understanding

Detailed prompt invariants and anti-pattern examples are intentionally deferred until the Phase 4 prompt implementation, where they can be calibrated against real examples instead of speculative architecture.

---

## Test modes

Single command, multiple modes, same grader infrastructure:

| Mode | Prompt shape | Detects |
|---|---|---|
| `standard` | "Explain X in your own words. Use an example." | Baseline understanding |
| `transfer` | "Given novel scenario Y, why does X apply?" | Application, generalization |
| `no_jargon` | "Explain X without using these words: [blocklist]." | Mimicry, parroting |
| `compress` | "Explain X in 1 sentence / 3 sentences / 1 paragraph / 1 analogy." | Abstraction control |
| `compare` | "Compare X and Z: similarities, differences, when each applies." | Relational understanding |

CLI (the discipline surface — focused, no GUI distraction):
- `starcall test embeddings` (defaults to `standard`)
- `starcall test embeddings --mode transfer`
- `starcall test embeddings --mode no-jargon`
- `starcall test embeddings --mode compress`
- `starcall test rag --mode compare --against fine-tuning`
- `starcall revise embeddings`
- `starcall due`
- `starcall review`

**CLI scope discipline:** the CLI exists for `test`, `revise`, `due`, and `review`. Everything else — sources, history, maps, misconceptions browsing, progress, reading — is GUI-only. If a new "browsing" or "inspecting" surface is requested, it goes to the GUI; if a new focused-flow surface is requested, it can also live in the CLI. This split keeps both tools sharp.

---

## GUI screens

Nine screens. Each one must answer at least one of the three load-bearing questions (claim / evidence / next). Anything that doesn't is rejected as Obsidian-clone drift.

| # | Screen | Answers | Contents |
|---|---|---|---|
| 1 | **Concept Dashboard** | claim, next | Grid of concepts grouped by status (`unseen / learning / understood / needs_review`) with maturity badges, trajectory chips (improving/stable/decaying), and counts. Click → Concept Detail. |
| 2 | **Concept Detail** | claim, evidence | Concept header (name, summary, why_it_matters, status, maturity), source evidence panel (see below), latest attempt verdict, recurring misconceptions, prereq dependency chips, "Test this" / "Revise" / "Add source" actions. |
| 3 | **Source Library** | evidence | List of all sources (book / paper / article / video / note), filterable by type and by linked concept, click to drill into a source's takeaways and attached concepts. |
| 4 | **Test / Explain Screen** | evidence | The grading surface in GUI form. Mode selector, prompt, confidence-before slider, multi-line explanation editor, submit → grader verdict rendered as compressed cards (score, sub-scores, missing_points, misconceptions, follow-up). |
| 5 | **Attempt Timeline** | evidence | Per-concept timeline of attempts with score, mode, calibration_gap, status_after, expandable to show full ai_feedback_json and the user's explanation text. Diff view between adjacent attempts. Assembled by `artifacts/attempts/timeline.ts` reading directly from the attempts table. |
| 6 | **Misconception Timeline** | evidence | Per-concept history of misconceptions: first seen, last seen, recurrence_count, severity, resolved-at. Linkable back to the attempts that surfaced them. |
| 7 | **Review Queue** | next | Today's due list ordered by trajectory (decaying first), with a one-click "Review now" that opens the Test screen pre-loaded for that concept. |
| 8 | **Concept Map** | claim | A *static* presentation of concept relationships (prereq / related / example_of / used_in) at a useful zoom. Not an infinite-zoom force-directed explorer. Node color = status; node size = recent attempt count. Click → Concept Detail. |
| 9 | **Study Next** | next | The visual counterpart of `starcall ask "what should I study next?"`. One primary recommendation with reasoning ("decaying trajectory, prereq for X"), plus 2–3 alternatives. Click → opens Test screen or Reading mode. |

Screens 4 (Test) and 5 (Timeline) are the irreducible evidence pair: one writes evidence, one inspects it. Everything else is convenience.

---

## Source evidence panel

Rendered on Concept Detail (screen 2). One concept, one panel, one frame of reference for "what do I actually know about this and why?"

```
Concept: Embeddings
Status:  learning            Maturity: learning
Trajectory: improving (last 3 scores: 62 → 71 → 76)

Sources
  - AI Engineering, Ch. 4 — "Vector representations"
  - OpenAI Cookbook: embedding retrieval example
  - Personal note (2026-05-23): "embeddings are coordinates not categories"

Evidence
  Latest explanation       (2026-05-23, standard mode) — score 76
  Latest follow-up         "When would two semantically opposite sentences land close?"
  Missing points (last 3)  loss objective, normalization, dimensionality tradeoffs
  Recurring misconceptions "embeddings encode meaning directly" (seen 3x, unresolved)
  Transfer attempts        1 of 1 passed (score 72)
  Calibration              avg gap +8 (slightly overconfident)
```

The panel is read-only. Mutations happen through dedicated actions (Test, Revise, Add source, Reading mode). This preserves the evidence-vs-mutation separation that keeps the grader trustworthy.

---

## Reading mode

A small dedicated GUI surface for the "I'm studying a source right now" flow:

1. **Read source** — paste-in or link to a source the user is reading.
2. **Write takeaway** — free-text, the user's own words, 1–5 sentences.
3. **Link to concept(s)** — multi-select existing concepts (or create one inline).
4. **Explain in own words** — opens the Test screen pre-seeded with the linked concept and the takeaway in the explanation buffer.

Reading mode is deliberately a *funnel into the test loop*, not a note-taking surface. Takeaways without a follow-up explanation are stored but do **not** count as evidence of understanding. They count as evidence of *exposure*, which is a different (and lesser) claim. This is the operational form of "source-backed but not source-dependent" — sources flow in, but only attempts come out the other side as evidence.

---

## Visual direction (locked intent; concrete tokens chosen at E0)

StarcallOS earns its name. The visual direction is **constellation cartography**, not generic-AI-dark-mode-with-gradient-blobs.

**Organizing metaphor:** *concepts are stars; prerequisite edges are constellation lines; understanding is the act of mapping the sky.* "Starcall" itself is the act of summoning the next concept to study — the Study Next screen literally answers "what star is the system calling you toward right now?"

**Anchors (load-bearing, will inform every screen):**

- **Concept Map** is the most explicit expression — concepts rendered as stars with brightness derived from `evidence_strength`, edges as faint constellation lines, status as star color (cool blue = `understood`, warm amber = `learning`, dim grey = `unseen`, red-shift = `needs_review`). Static presentation; no infinite-zoom force-directed exploration (anti-goal preserved).
- **Concept Dashboard** uses constellation grouping over status grouping — concepts cluster into named constellations by domain/prereq family, not into rows by status.
- **Study Next** centers the called star; alternatives orbit at lower visual weight.
- **Attempt Timeline + Misconception Timeline** read as star-evolution charts — the same star observed at different points in time, with brightness/color shifting per attempt.

**Aesthetic discipline (avoid):**

- Generic AI dark-mode-with-gradient-blobs aesthetic
- Twinkle/parallax for decoration's sake; motion must serve evidence clarity
- Cartoonish space iconography (rockets, planets, astronauts)
- Star-field backgrounds with no information density (decorative noise)
- Heavy navy-on-cyan gamer palette

**Aesthetic discipline (favor):**

- Editorial restraint — dense information, generous negative space, intentional typography
- A real palette chosen against actual astronomical photography references (deep-sky-survey blues, starlight whites, supernova warm accents — picked at E0 from references, not invented in CSS)
- Motion that *reveals* belief evolution (a star brightening when a concept's evidence strengthens; a constellation line tracing on hover to show a prereq relationship)
- Both light and dark themes must feel intentional — *do not default to dark just because space*. A bright observatory-paper light theme is on the table.

**Concrete tokens (palette, typography, motion timing) are intentionally deferred to E0**, where they get chosen against real references (per the web `design-quality.md` rule against vague-defaults). What's locked here is the metaphor and the discipline. The palette is downstream.

---

## Derived signals (computed, no schema)

| Signal | How |
|---|---|
| **Trajectory** | `stable / improving / decaying` from last 3 attempts' scores. Surfaced in dashboard chips and the `due` ordering. **Never persisted as a core status** — that would be resolver inflation. |
| **Maturity label** | `unseen / learning / understood / durable`. Computed from core status + multi-mode evidence (see Status & scoring above). Render-time only. |
| **Calibration interpretation** | "Overconfident" / "well-calibrated" / "underconfident" from `calibration_gap`. Stored as number, named at render time. |
| **Evidence strength** | A composite signal combining recency (how long since the last attempt), transfer success rate, misconception recurrence (negative weight), calibration quality, and trajectory stability. Surfaced as a chip on Concept Detail and used to order the "what do I weakly understand?" view in `ask`. Never a status — its only consumers are GUI ranking and `ask` output. |
| **Dependency failure** | At grade time, if `missing_points` reference an entity that matches a `prerequisite` edge target, and that prereq is `weak` or `learning`, surface in verdict: *"Your prereq `vectors` is weak — that may be why this is hard."* |

All derived signals are computed in `core/resolver/`. None of them write to the DB, none of them gate behavior the way the core status does. This is the boundary the resolver-inflation risk protects.

---

## Implementation phases

Phases now build the **services package first** (headless, fully testable), then the **Electron desktop app on top**, with the **CLI as a late, optional wrapper**. The services package is the only thing both interfaces depend on.

### Headless services package (~10.5 focused days — the engine)

| Phase | Scope | Days |
|---|---|---|
| 0 | Monorepo scaffold: pnpm workspace, `packages/services` + `packages/shared`, tsconfig base, eslint/prettier, vitest, migrations runner, baseline `core/infra/db.ts` opening better-sqlite3 against a test fixture. Single-file `core/events.ts` with a minimal emit/persist helper + the `events` table migration — events are the source of truth from day one, but kept as one file until later phases prove the need for a folder. | 0.5 |
| 1 | Concepts service + domain entities: add (mandatory `why_it_matters`), list, show. First `events` ledger entries (`concept_added`). | 1.0 |
| 2 | Sources service + `source_excerpts` schema: add, attach, list, reading-mode takeaway capture. `takeaway_captured` event emitted. | 0.5 |
| 3 | Attempts service without AI: explanation capture, `confidence_before` capture, attempt lineage assembly. `attempts` table append-only enforced at the service boundary. | 0.5 |
| 4 | **AI critique (standard mode only)** — `evaluation/` package: grader prompt v1, zod-validated structured tool-use output, resolver sums sub-scores into `core/resolver/scoring.ts`, `calibration_gap` stored, misconception extraction → upsert into `misconceptions` with recurrence tracking, `attempt_created` + `status_changed` events. **Metadata-aware prompting**: the grader prompt receives the concept's attached source titles + types + the user's takeaway notes as *contextual* study-context (never raw source text), with explicit anti-mimicry instructions; the snapshot is persisted into `attempts.source_metadata_snapshot_json` for replay. **Includes predictability-test fixture (5 known-good + 5 known-bad explanations) that CI runs against every grader-prompt change. The fixture must include at least one case where the takeaway-note wording is repeated verbatim in the explanation — that case must not get a higher score than its semantically-equivalent siblings, proving the anti-mimicry instruction holds.** | 2.5 |
| 5 | Revision lineage service: build-revise-from-prior, score delta computation | 0.5 |
| 5.5 | Test modes: transfer, no_jargon, compress, compare. `mode_results` table populated. Derived maturity label implementation in `core/resolver/maturity.ts` (multi-mode evidence requirements per Status & scoring). | 1.0 |
| 5.7 | Misconceptions service: severity-ranked retrieval, recurrence_count surface, `misconception_resolved` event | 0.5 |
| 6 | Concept graph service: link, unlink, map-payload, dependency-failure detection at grade time. Four-relation edges only. | 1.0 |
| 7 | Review service: scheduler, due-queue assembly, trajectory-aware ordering, `review_outcomes` table populated, `review_completed` event | 1.0 |
| 8 | `ask` service: structured query over user state (no RAG over the world). "What misconceptions keep coming back?" Powered by `evidence_strength` ordering in `core/resolver/evidence-strength.ts`. | 1.0 |
| 9 | AI/ML seed pack: 16 concepts + edges, idempotent loader | 0.5 |
| | **Services package total** | **~10.5 days** |

### Electron desktop app (~2–3 weeks for MVP, ~4–6 weeks for solid V1)

| Phase | Scope | Estimate |
|---|---|---|
| E0 | Electron + Vite scaffold under `apps/desktop`: main + preload + renderer skeletons, contextIsolation + sandbox enabled, narrow `window.starcall` API via contextBridge, one round-trip IPC smoke test (`ping`), `data/starcall.db` resolution via `app.getPath('userData')` in prod and a fixture path in dev | 1–2 days |
| E1 | IPC handler layer for all services-package operations: handlers in `electron/ipc/*` that validate with zod (from `packages/shared`), call services, return DTOs. Renderer-side typed API client wrapping `window.starcall.*` with TanStack Query. | 2 days |
| E2 | Screens 1–2: Concept Dashboard, Concept Detail (with source evidence panel and maturity badge) | 3–4 days |
| E3 | Screens 3–4: Source Library, Test / Explain Screen (the primary write surface) | 3–4 days |
| E4 | Screens 5–6: Attempt Timeline, Misconception Timeline | 2–3 days |
| E5 | Screens 7–9: Review Queue, Concept Map (static presentation), Study Next | 3–4 days |
| E6 | Reading mode + cross-screen polish, keyboard nav, reduced-motion + a11y pass, Electron packaging (Forge → installer for current OS) | 2–3 days |

### CLI layer (~0.5–1 day — late addition)

| Phase | Scope | Estimate |
|---|---|---|
| C0 | `apps/cli` with commander entry. Commands: `test`, `revise`, `due`, `review`. Imports `packages/services` directly, opens the same SQLite file via the same `core/infra/db.ts`. | 0.5–1 day |

### Milestones

| Milestone | Scope | Estimate |
|---|---|---|
| **Services MVP** | Phases 0–4 + 9. Headless end-to-end on one concept; no UI yet. Provable from vitest alone. | ~5 focused days |
| **Services V1** | All headless phases (0–9). Engine complete. | ~10.5 focused days |
| **Electron MVP** | Services V1 + E0–E3. Dashboard, Concept Detail (with evidence panel), Source Library, Test screen. Daily-use viable. | ~2–3 weeks |
| **Solid Electron + CLI V1** | All headless + E0–E6 + C0. Nine screens, reading mode, packaged installer, CLI wrapper. | ~4–6 weeks |
| **Polished portfolio app** | V1 + visual polish, onboarding, demo-mode seed, optional auto-update | ~8–12 weeks |

The services package must earn the GUI. If `services/attempts.ts` doesn't produce a satisfying grader verdict on one real concept by end of Phase 4, no amount of screens will save it. The Electron MVP only starts when the headless services are usable from a vitest spec.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Grader drift / black-boxiness** | HIGH | Predictability fixture (Phase 4); `prompt_version` stored with every attempt; rubric kept ≤ 5 dimensions; trust-test gate before any grader-prompt change |
| **False-positive misconception inference** — grader interprets missing detail as an active misconception | HIGH | Grader prompt strictly separates `missing_points` (omission) from `misconceptions` (explicit contradictory belief). Misconceptions require quotable evidence from the user's text. Calibration fixture includes explanations that omit detail without false beliefs — those must produce zero misconceptions. Misconception extraction is advisory, not authoritative. |
| **LLM is too generous** — everything's a B+ | HIGH | Hand-graded calibration set; explicit "no-evidence = no-claim" instruction; forced structured tool-use output, never free-form prose |
| **Misconception normalization instability** — semantically similar misconceptions extracted with different wording, abstraction level, specificity, or framing (symptom vs. root cause), preventing reliable recurrence tracking | MEDIUM | V1 uses exact-string matching on normalized lowercase statements (strip punctuation/whitespace). Accept some duplication initially. **Do not introduce embeddings or semantic clustering until recurrence tracking proves valuable enough to justify the complexity.** Revisit post-V1 only if recurring misconceptions become operationally important. This preserves the compression philosophy and defends against premature semanticization. |
| **Cost / latency** per attempt | MEDIUM | Claude Haiku is plenty for grading; content-hash cache so regrading identical text is free |
| **High-friction flow causes abandonment** | MEDIUM | One concept, one full loop end-to-end before any other surface. If `starcall test embeddings` doesn't feel valuable on day 1, broader features won't save it. |
| **Scope creep toward flashcards / Obsidian-clone** | MEDIUM | Anti-goals list enforced in every PR description |
| **GUI feature creep** — visual surfaces accumulate dashboards, settings, customization, and second-brain features until the product becomes a knowledge base rather than a learning verifier | HIGH | The three-question screen gate (claim / evidence / next) is hard, not advisory. No screen ships without naming the question it answers in its PR description. New screens are deferred-by-default. The nine V1 screens are a ceiling, not a starting point. |
| **Resolver inflation** (graduated `understood-1/2/3`, ensemble graders, etc.) | MEDIUM | Resolver stays a four-line summation. Maturity gradations live at render time, never in the core status column. New signals go into the *attempt artifact*, not the verdict logic. |
| **Knowledge-graph inflation** (ontologies, edge taxonomies) | LOW | Four relations only. Concept Map screen is presentation, not browsable. |
| **API key leakage** | LOW | `.env` gitignored, `data/` gitignored, pytest-recording filters auth headers |

---

## Anti-goals (explicit refusal list)

The GUI direction has loosened a few of the prior anti-goals. The new line is sharper but narrower.

**Now in scope (revised from prior plan):**

- A simple, *static* concept-map visualization on one screen (presentation, not browsing)
- A source library screen for browsing sources the user has added
- An attempt timeline screen for inspecting evidence over time
- A misconception timeline screen for the same

These are in scope because each one answers one of the three load-bearing questions and replaces something that would otherwise be terminal-output ephemera.

**Still anti-goals:**

- An Obsidian / Roam clone — backlinks for their own sake, freeform note graph
- Infinite-zoom force-directed graph explorer with pan/zoom drilldowns
- Multi-user / sync / cloud workspace
- Arbitrary content import (PDF, YouTube, web clipper, transcript extraction)
- **Source-content grading of any kind**: raw source text ingestion, embeddings or vector similarity between explanation and source, lexical/coverage scoring against takeaway notes, contradiction checks against source documents, retrieval systems over source content. The grader sees source *metadata* only (titles, types, user takeaway notes), and that metadata is contextual-not-authoritative. See the "Grader source-metadata policy" section.
- LLM-as-tutor chat surface
- Flashcards / passive recall
- Spaced-repetition science (SM-2 etc. — a simple scheduler is enough)
- Embeddings / vector search (V1 `ask` is structured, not semantic)
- Prediction-before-learning workflows (doubles writes for low signal)
- Source quality labeling (premature — defer until retrospective evidence exists to compute it from outcomes)
- A "second-brain" replacement positioning — this is a *learning verifier*, not a knowledge base

If pressure pulls toward any of these, defer.

**The GUI screen gate:** every proposed new screen must answer one of:
1. What do I claim to understand?
2. What evidence supports that claim?
3. What should I study or test next?

A proposed screen that doesn't answer at least one of these is rejected on philosophical grounds, not just on scope grounds.

---

## V1 success criterion (one criterion, not a checklist)

> The user can open the Study Next screen (or run `starcall ask "what should I study next?"`), get one concept name they actually study, and — after studying it — that concept's status genuinely changes based on a captured, gradeable, persisted explanation. The Concept Detail screen then shows the new evidence (latest attempt, updated trajectory, any new or resolved misconceptions) within the same session.

If that single loop holds — across either interface — every other feature is additive. If it doesn't, no quantity of screens will save it.

---

## Open questions (resolve before Phase 0)

1. **Editor surface for explanations** — in the GUI, a Monaco-style code editor or a plain textarea with a "Did you mean to keep going?" nudge? In the CLI, `$EDITOR` (with `code -w` as a Windows-with-VSCode-friendly default)?
2. **API key handling** — OS keychain via `keytar` (recommended for desktop app shipping a real installer), or `.env` in the userData directory? Keychain is more user-friendly but harder to develop against; `.env` is the dev default.
3. **Claude model** — Haiku 4.5 for grading, Sonnet 4.6 for `ask` synthesis? Confirm.
4. **Concept identity** — slug from lowercased name, immutable; display name editable? (The deferred `concept_aliases` table only earns its existence if real alias conflicts appear post-V1.)
5. **Single DB or per-domain?** — V1 single `data/starcall.db` resolved via `app.getPath('userData')` in prod and a fixture path in dev. Multi-domain deferred.
6. **Renderer state management split** — Zustand for UI-only state (drafts, modals, current view) + TanStack Query for server state (everything fetched via IPC). Confirm this split; alternative is Zustand-only with manual cache invalidation, which is simpler now but more work as screens accumulate.
7. **ORM vs query builder** — Drizzle (TS-native ORM, generated types, migrations) or Kysely (pure typed query builder, lighter)? Both are good fits; Drizzle is the default unless you've already chosen.

### Locked decisions (do not re-open without strong reason)

- **2026-05-23 — Language: TypeScript/Node end-to-end.** No Python sidecar in V1. Python remains a future candidate only for isolated subsystems (local ML, embeddings, heavy offline analysis), never the V1 critical path. Rationale captured in the Tech stack section's "Language decision" note.

---

## Forward-looking observation (preserved, not licensing premature work)

> Longitudinal cognition systems are fundamentally noisy identity-resolution systems. Eventually StarcallOS will encounter concept identity drift, misconception identity drift, abstraction mismatch, semantic overlap, and evolving mental models. Cognition over time is graph evolution under imperfect semantic compression.

V1 deliberately uses exact-string matching for misconception normalization, no embeddings, no semantic clustering, and four fixed edge relations. This observation is preserved here so that when those V1 limits start binding, the choice to relax them is conscious, not accidental. **Do not pre-build for this.**

---

## Governance notes

- This file is the canonical plan. Future revisions amend in place.
- The **compression invariant** applies: every addition must purchase compression elsewhere. Adding a field, command, mode, status, or table without a matching reduction in cognitive load is drift, and is rejectable on those grounds alone.
- The split between StarcallOS (cognition evidence) and FalsifyAI (AI behavior evidence) is intentional. They share philosophy, not code. StarcallOS does not depend on FalsifyAI.
- `data/` is gitignored. Each user's `starcall.db` is personal.
