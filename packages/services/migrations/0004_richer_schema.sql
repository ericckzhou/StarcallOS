-- Migration 0004: Richer extraction schema
-- Recreates semantic_chunks with extended block_type + structural fields.
-- Extends concepts with citation grounding and importance scores.
-- Recreates concept_edges with expanded edge_type vocabulary.

-- ── semantic_chunks: recreate with block_type and new fields ──────────────────
CREATE TABLE semantic_chunks_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content       TEXT    NOT NULL,
  page_start    INTEGER NOT NULL,
  page_end      INTEGER NOT NULL,
  block_type    TEXT    NOT NULL
                CHECK (block_type IN (
                  'definition','theorem','mechanism','example','derivation',
                  'misconception_zone','assumption','transition',
                  'claim','evidence','warning','formula','procedure','comparison'
                )),
  section_path  TEXT    NOT NULL DEFAULT '[]',
  claim         TEXT,
  assumptions   TEXT    NOT NULL DEFAULT '[]',
  example_quote TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO semantic_chunks_v2
  (id, source_id, content, page_start, page_end, block_type, created_at)
  SELECT id, source_id, content, page_start, page_end, chunk_type, created_at
  FROM semantic_chunks;
DROP TABLE semantic_chunks;
ALTER TABLE semantic_chunks_v2 RENAME TO semantic_chunks;

-- ── concepts: add citation grounding and importance scores ────────────────────
ALTER TABLE concepts ADD COLUMN section_path       TEXT NOT NULL DEFAULT '[]';
ALTER TABLE concepts ADD COLUMN exam_value         REAL NOT NULL DEFAULT 0;
ALTER TABLE concepts ADD COLUMN misconception_risk REAL NOT NULL DEFAULT 0;
ALTER TABLE concepts ADD COLUMN centrality_score   REAL NOT NULL DEFAULT 0;

-- ── concept_edges: extended edge_type vocabulary ──────────────────────────────
CREATE TABLE concept_edges_v2 (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id   INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  to_id     INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  edge_type TEXT    NOT NULL DEFAULT 'requires'
            CHECK (edge_type IN (
              'requires','enables','related',
              'contrasts_with','example_of','causes','prevents'
            )),
  UNIQUE(from_id, to_id, edge_type)
);
INSERT INTO concept_edges_v2 SELECT * FROM concept_edges;
DROP TABLE concept_edges;
ALTER TABLE concept_edges_v2 RENAME TO concept_edges;
