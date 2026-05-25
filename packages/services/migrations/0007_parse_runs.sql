-- Migration 0007: parse_runs + parser version stamps
-- Append-only audit of every SOURCES_PROCESS invocation so parser/grammar/layout
-- changes are diffable across time. Also stamps every candidate row with the
-- parser version that produced it.

CREATE TABLE parse_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  status              TEXT    NOT NULL DEFAULT 'success',  -- success | failed | interrupted
  error_msg           TEXT,
  mode                TEXT    NOT NULL,                    -- deterministic | candidate_gated | full
  parser_version      TEXT    NOT NULL,
  grammar_version     TEXT    NOT NULL,
  layout_version      TEXT    NOT NULL,
  page_count          INTEGER NOT NULL DEFAULT 0,
  block_count         INTEGER NOT NULL DEFAULT 0,
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  relation_count      INTEGER NOT NULL DEFAULT 0,
  equation_count      INTEGER NOT NULL DEFAULT 0,
  misconception_count INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  llm_call_count      INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens    INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens   INTEGER NOT NULL DEFAULT 0,
  diagnostics_json    TEXT    NOT NULL DEFAULT '{}'        -- layout diagnostics + budget info
);
CREATE INDEX idx_parse_runs_source_id_started_at
  ON parse_runs(source_id, started_at DESC);

ALTER TABLE concept_candidates       ADD COLUMN parser_version TEXT;
ALTER TABLE relation_candidates      ADD COLUMN parser_version TEXT;
ALTER TABLE equation_candidates      ADD COLUMN parser_version TEXT;
ALTER TABLE misconception_candidates ADD COLUMN parser_version TEXT;
