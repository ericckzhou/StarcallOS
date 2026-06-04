# Security Policy

## Threat model

StarcallOS is a local-first Electron desktop app. It has no server, no accounts,
and no remote backend. Your sources, notes, attempts, and API keys live on your
machine.

The trust boundary is the **IPC contract** between the renderer and the main
process:

- The **renderer** is treated as the less-trusted surface. It renders content it
  did not author — text extracted from PDFs, scraped article text, and LLM
  output. It never touches SQLite, the filesystem, API keys, or provider SDKs.
- The **main process** owns all files, settings, the database, network calls,
  and LLM calls. Every mutating IPC handler validates its input
  (`packages/services/src/core/ipc-schemas.ts`).
- **API keys** are stored in an OS-encrypted settings file via Electron
  `safeStorage` (DPAPI / Keychain / libsecret). They are never written to disk
  in plaintext when a keyring is available, never sent to the renderer (the
  renderer only sees a configured boolean), and never inlined into the build.

Hardening in place: `contextIsolation` on, `nodeIntegration` off, renderer
`sandbox` on, a Content-Security-Policy on every renderer response, denied
`window.open` / blocked off-origin navigation, http/https-only external links,
and an SSRF guard on the URL importer (private/loopback/link-local addresses are
refused).

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Email **ericckzhou@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- the version / commit you tested.

You can expect an initial acknowledgement within a few days. Once a fix is
released, you're welcome to be credited in the release notes.

## Supported versions

This is an early-stage project; only the latest release on the
[Releases page](https://github.com/ericckzhou/StarcallOS/releases/latest)
receives security fixes.
