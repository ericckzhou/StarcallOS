# Contributing to StarcallOS

Thanks for your interest. StarcallOS is an evidence-backed learning OS for PDFs
and text sources. Before contributing, skim [ARCHITECTURE.md](ARCHITECTURE.md)
(the canonical product + architecture reference) and the `CLAUDE.md` operating
guide.

## Setup

Requires Node **22.5+** (for the built-in `node:sqlite`) and pnpm 11+.

```sh
git clone https://github.com/ericckzhou/StarcallOS && cd StarcallOS
pnpm install
pnpm -C packages/shared build && pnpm -C packages/services build
pnpm -C apps/desktop dev
```

Copy `.env.example` to `.env` only if you want an LLM key picked up in dev — it's
optional (extraction runs with zero keys) and never shipped in a build.

## Architecture rules (non-negotiable)

- Data flows one direction: `renderer → preload/contextBridge → IPC → main →
  services → DB`.
- The renderer never touches SQLite, API keys, `fs`, or provider SDKs.
- `packages/services` is pure TypeScript/Node — no DOM, no Electron imports.
- `packages/shared/src/index.ts` is the renderer/main IPC contract.
- The `events` table is append-only — never update or delete its rows.
- Every **mutating** IPC handler must validate its input with a Zod schema in
  `packages/services/src/core/ipc-schemas.ts` and `validateIpc(...)`.
- After editing `packages/services` or `packages/shared`, rebuild them before
  restarting Electron (electron-vite consumes their `dist/` output).

## Before opening a PR

```sh
pnpm typecheck
pnpm test
```

- Parser/grammar/repo changes: run `pnpm test`.
- Cross-package type/API changes: run `pnpm typecheck`.
- Visible frontend changes: run the app and verify the affected screen.
- Bump the relevant version in `packages/services/src/core/version.ts` when you
  change parser, grammar, or layout behavior (see CLAUDE.md → Parser Versioning).

Keep changes narrow and match existing local patterns rather than introducing
broad abstractions. Branch off `dev`; PRs target `dev`.

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please report privately,
don't open a public issue.
