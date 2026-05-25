-- Migration 0005: Deterministic concept candidates
-- Stores zero-LLM candidate terms and relations produced by the rule/pattern
-- parser in src/ingestion/candidates.ts. Lives alongside the LLM-extracted
-- `concepts` table so the two can be compared per source.

CREATE TABLE concept_candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  term          TEXT    NOT NULL,
  normalized    TEXT    NOT NULL,
  confidence    REAL    NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0,
  first_page    INTEGER NOT NULL DEFAULT 0,
  section_path  TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  evidence      TEXT    NOT NULL DEFAULT '[]',   -- JSON array of {source, quote, page, pattern?}
  signals       TEXT    NOT NULL DEFAULT '[]',   -- JSON array of distinct signal sources
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_concept_candidates_source ON concept_candidates(source_id);
CREATE INDEX idx_concept_candidates_norm   ON concept_candidates(source_id, normalized);
CREATE INDEX idx_concept_candidates_conf   ON concept_candidates(source_id, confidence DESC);

CREATE TABLE relation_candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  from_term     TEXT    NOT NULL,
  to_term       TEXT    NOT NULL,
  relation_kind TEXT    NOT NULL
                CHECK (relation_kind IN (
                  'requires','causes','enables','contrasts_with','example_of'
                )),
  quote         TEXT    NOT NULL,
  page          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_relation_candidates_source ON relation_candidates(source_id);

CREATE TABLE misconception_candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote         TEXT    NOT NULL,
  page          INTEGER NOT NULL DEFAULT 0,
  section_path  TEXT    NOT NULL DEFAULT '[]',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_misconception_candidates_source ON misconception_candidates(source_id);
