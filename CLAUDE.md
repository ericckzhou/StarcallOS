# StarcallOS — Claude Code Guide

## Project
Electron desktop app for AI/ML active-recall learning. Local-first, TypeScript/Node end-to-end.
Canonical spec: `PLAN.md`. Do not propose features in the anti-goals list.

## Monorepo layout
```
packages/services/   — cognition evidence engine (pure TS, Node.js only)
packages/shared/     — IPC contracts (renderer ↔ main)
apps/desktop/        — Electron (main + preload + renderer)   [Phase E1+]
apps/cli/            — CLI via commander                      [post-V1]
```

## Key rules
- Renderer never touches SQLite or API keys — everything goes via contextBridge → IPC → main → services
- node:sqlite loaded via require() wrapper (src/core/infra/sqlite.ts) — Vite cannot resolve node:sqlite directly
- No Python in V1 critical path
- Status is two-layered: core DB status (deterministic) + maturity label (render-time only)
- All events are append-only; never update or delete from the events table
- Grader is content-blind to source text — only titles, types, takeaway notes allowed in prompt

## Commands
```
pnpm test              # run vitest (packages/services)
pnpm typecheck         # tsc --noEmit across all packages
pnpm build             # compile all packages
```

## Current phase
Phase 0 complete — monorepo scaffold, migrations runner, events table, smoke test passing.
Next: Phase 1 — domain types, schema migrations, core/resolver, zod validation.

## SQLite note
Uses Node.js 22 built-in node:sqlite (experimental). No native compilation required.
better-sqlite3 excluded — needs Visual Studio Build Tools on Windows.
When setting up Electron (Phase E0), revisit: Electron ships its own Node and may need electron-rebuild.
