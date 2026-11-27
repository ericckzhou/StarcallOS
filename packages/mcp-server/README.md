# @starcall/mcp-server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server
that lets a local MCP client (a personal assistant, Claude Code, the MCP
Inspector) search and read your StarcallOS library: document passages,
promoted concepts with their source evidence, learning progress, and,
if you opt in, your highlights and notes.

It runs as a **stdio subprocess** started by the client. It opens no network
port. StarcallOS works exactly the same whether or not anything uses it.

## Run it

Requires Node.js 22.13 or newer (for `node:sqlite`).

```sh
pnpm -C packages/services build
pnpm -C packages/mcp-server build
node --no-warnings packages/mcp-server/dist/index.js --help
```

Open StarcallOS at least once after updating the code. The app owns database
migrations, and the server refuses to read a database that is behind (or ahead
of) the code it was built from.

For passage search, build the passage index in the app first (Settings →
Passage index, or the Ask tab). Until then `search_passages` returns nothing,
but concepts, progress and highlights still work.

### Client configuration

Any MCP client that can start a stdio server works. The general shape:

```json
{
  "command": "node",
  "args": [
    "--no-warnings",
    "C:/path/to/StarcallOS/packages/mcp-server/dist/index.js",
    "--scopes", "passages,concepts,progress"
  ]
}
```

Claude Code (user scope, so the local path never lands in a committed file):

```sh
claude mcp add starcall --scope user -- node --no-warnings C:/path/to/StarcallOS/packages/mcp-server/dist/index.js
```

MCP Inspector:

```sh
npx @modelcontextprotocol/inspector node --no-warnings packages/mcp-server/dist/index.js
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--db <path>` | `STARCALL_DB`, else `<userData>/stellaria.db` (`%APPDATA%\StarcallOS` on Windows) | Database file |
| `--scopes <list>` | `passages,concepts,progress` | What to expose (see below) |
| `--embed-url <url>` | `http://127.0.0.1:11434/v1` | Embedding server for semantic search. Must be loopback |
| `--embed-model <name>` | the model the passage index was built with | Embedding model |
| `--no-embeddings` | off | Keyword search only |
| `--log <path\|off>` | `<userData>/mcp.log` | Audit log (metadata only) |

## Tools

| Tool | Scope | Returns |
|---|---|---|
| `search_passages` | passages | Hybrid (keyword + semantic) passage search. Each hit: chunk id, source id and title, page range, section, text |
| `get_passage` | passages | One passage by chunk id, plus up to 2 neighbours on each side |
| `list_sources` | passages | Documents with page, concept and passage counts. No local file paths |
| `search_concepts` | concepts | Promoted concepts matching words in the name or definition |
| `get_concept` | concepts | Definition and narrative fields, source evidence (page, quote, highlight id), prerequisites (learn first / unlocks / blocked by), constellations, hubs. With `progress`: mastery stage, attempt count, best stage, review due date. With `notes`: your concept notes |
| `get_learning_progress` | progress | Level, XP, challenges, calibration, due/new counts, due concepts, last 14 days of activity |
| `search_highlights` | highlights | Your persisted PDF highlights (never sticky notes), with source, page, concept and creation time |
| `get_highlight` | highlights | One highlight plus the passage around it on its page |

**Scopes.** `passages`, `concepts` and `progress` are on by default.
`highlights` and `notes` are opt-in because they are text you wrote yourself.
`notes` has no tools of its own: it adds concept notes to `get_concept` and
highlight notes to the highlight tools.

Every result that quotes library text carries a `notice` field: the text is
reference material, not instructions.

## Security and privacy model

- **No listener.** stdio only. The only process that can talk to the server is
  the one that started it. This is a local trust boundary, not authentication.
  Anything you let start the server can read what its scopes allow.
- **Read-only.** The database is opened with SQLite `readOnly`, so any write,
  including a WAL checkpoint, fails. Migrations never run here. The server
  calls only exported `@starcall/services` read functions and contains no SQL
  of its own.
- **WAL.** Reading while the app is open is safe: commits show up as they land,
  and the app's checkpoints are not blocked. If the `-wal`/`-shm` files are
  missing, SQLite creates empty ones on open. The main database file is never
  modified.
- **No API keys.** The server never opens the app's `settings.json`, which holds
  the provider keys. Embedding settings come from flags.
- **Loopback-only embeddings.** The embedding URL must be `127.0.0.0/8`, `::1`,
  or `localhost` resolving only to loopback. This is checked at startup and
  before every request, and redirects are refused. A query embedding that takes
  longer than 8 s falls back to keyword search.
- **Minimal content.** Your answer text, grader output, LLM call logs and
  settings are never returned. `get_concept` reports an attempt summary only.
- **Audit log.** One JSON line per call: tool name, ok/error, duration, result
  count. Never query text or content. It rotates at about 1 MB.
- **Where results go is up to the client.** If your client forwards tool
  results to a cloud model, the quoted library text goes with them. Control
  that in the client.
