-- Migration 0003: Evidence Engine Schema
-- Replaces the basic concepts table with the full evidence-based learning model.

DROP TABLE IF EXISTS concepts;

-- PDF sources ingested into the system
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL,
  title       TEXT,
  author      TEXT,
  file_path   TEXT    NOT NULL,
  page_count  INTEGER,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','ready','failed')),
  error_msg   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Semantic chunks: concept-boundary segments spanning one or more pages
CREATE TABLE IF NOT EXISTS semantic_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  page_start  INTEGER NOT NULL,
  page_end    INTEGER NOT NULL,
  chunk_type  TEXT    NOT NULL
              CHECK (chunk_type IN (
                'definition','theorem','mechanism','example',
                'derivation','misconception_zone','assumption','transition'
              )),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Concepts extracted from semantic chunks
CREATE TABLE IF NOT EXISTS concepts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  slug            TEXT    NOT NULL,
  importance      TEXT    NOT NULL DEFAULT 'core'
                  CHECK (importance IN (
                    'foundational','core','supporting','peripheral','reference_only'
                  )),
  definition_text TEXT    NOT NULL,
  why_exists      TEXT    NOT NULL,
  what_breaks     TEXT    NOT NULL,
  where_reappears TEXT    NOT NULL DEFAULT '[]',
  chunk_ids       TEXT    NOT NULL DEFAULT '[]',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_concepts_source ON concepts(source_id);
CREATE INDEX IF NOT EXISTS idx_concepts_importance ON concepts(importance);

-- Dependency edges: requires | enables | related
CREATE TABLE IF NOT EXISTS concept_edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id   INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  to_id     INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  edge_type TEXT    NOT NULL DEFAULT 'requires'
            CHECK (edge_type IN ('requires','enables','related')),
  UNIQUE(from_id, to_id, edge_type)
);

-- Misconceptions: proactively extracted per concept
CREATE TABLE IF NOT EXISTS misconceptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id   INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  description  TEXT    NOT NULL,
  why_think_it TEXT    NOT NULL,
  why_wrong    TEXT    NOT NULL,
  test_prompt  TEXT    NOT NULL,
  seen_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'unresolved'
               CHECK (status IN ('unresolved','resolved')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Evidence tasks generated per concept × kind
CREATE TABLE IF NOT EXISTS evidence_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL
             CHECK (kind IN (
               'definition','connection','application',
               'misconception_resistance','compression'
             )),
  prompt     TEXT    NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Mastery: compression stage (0-5) per concept
CREATE TABLE IF NOT EXISTS mastery (
  concept_id        INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  compression_stage INTEGER NOT NULL DEFAULT 0 CHECK (compression_stage BETWEEN 0 AND 5),
  last_updated      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Evidence records: graded user attempts on tasks
CREATE TABLE IF NOT EXISTS evidence_records (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id                 INTEGER NOT NULL REFERENCES evidence_tasks(id) ON DELETE CASCADE,
  concept_id              INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  user_response           TEXT    NOT NULL,
  score                   TEXT    NOT NULL
                          CHECK (score IN ('understood','recognizes','gap','misconception')),
  compression_stage       INTEGER NOT NULL CHECK (compression_stage BETWEEN 0 AND 5),
  gaps_detected           TEXT    NOT NULL DEFAULT '[]',
  misconceptions_detected TEXT    NOT NULL DEFAULT '[]',
  grader_reasoning        TEXT,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_records_concept ON evidence_records(concept_id);
