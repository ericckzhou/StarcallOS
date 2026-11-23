-- Migration 0031: Persistent LLM call trace.
--
-- One row per chatJSON call (success or failure), appended by the trace sink
-- Electron main installs at startup. Append-only like `events`: rows are never
-- updated. Stores metadata only — never prompt or completion text — so the
-- table is safe to keep indefinitely and cheap to aggregate.
--
--   status          'ok' | 'error'
--   prompt_hash     first 16 hex of sha256(system prompt) — identifies which
--                   prompt/contract version produced a result
--   cache_read_tokens  Anthropic prompt-cache reads (0 otherwise)
--   retries         provider-level retries before success/failure
--   parse_ok        UNUSED (never written). Structured-output validation
--                   failures are recorded as their own status='error' rows
--                   by chatStructured instead.
CREATE TABLE IF NOT EXISTS llm_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  pass               TEXT    NOT NULL,
  provider           TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
  error_message      TEXT,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  retries            INTEGER NOT NULL DEFAULT 0,
  prompt_hash        TEXT    NOT NULL,
  parse_ok           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_pass ON llm_calls (pass, created_at);
