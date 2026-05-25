-- Migration 0006: Deterministic equation candidates
-- Equations are evidence attached to concepts, not concepts themselves.
-- attached_term holds the normalized term of the nearest preceding heading
-- candidate (null if none was in scope).

CREATE TABLE equation_candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id      INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  latex          TEXT    NOT NULL,
  variables      TEXT    NOT NULL DEFAULT '[]',  -- JSON array of strings
  page           INTEGER NOT NULL DEFAULT 0,
  reading_order  INTEGER NOT NULL DEFAULT 0,
  section_path   TEXT    NOT NULL DEFAULT '[]',  -- JSON array of strings
  attached_term  TEXT,                            -- normalized term of attached candidate (nullable)
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_equation_candidates_source   ON equation_candidates(source_id);
CREATE INDEX idx_equation_candidates_attached ON equation_candidates(source_id, attached_term);
