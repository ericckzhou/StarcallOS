-- Migration 0036: Retrieval chunk index (RAG foundation, PR 1).
--
-- rag_chunks is a DERIVED index of the deterministic layout output
-- (segmentPdf / segmentText blocks), built by the zero-LLM chunker
-- (ingestion/chunker.ts). It is safe to wipe, but processing RECONCILES it by
-- chunk_key instead of wiping, so an unchanged document causes no writes and
-- no re-embedding (syncSourceChunks in knowledge/repos/rag_chunks.ts).
--
--   chunk_key   content-addressed id: sha256(text) prefix + '#' + duplicate
--               index within the source. Stable across re-processing while the
--               text is unchanged; eval labels reference chunks by this key.
--   ordinal     position of the chunk in reading order (0-based)
--   section_*   heading path from buildSectionPath (running headers removed);
--               section_text is the joined path, indexed by FTS
--   block_*     readingOrder range of the source layout blocks it came from
--
-- FTS5 availability was verified for both runtimes that open this DB:
-- Node 22.16 (SQLite 3.49.1, tests) and Electron 42 / Node 24.16 (SQLite
-- 3.53.0, app). core/infra/fts.ts exposes a runtime check.
CREATE TABLE IF NOT EXISTS rag_chunks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_key         TEXT    NOT NULL,
  ordinal           INTEGER NOT NULL,
  text              TEXT    NOT NULL,
  heading           TEXT,
  section_path_json TEXT    NOT NULL DEFAULT '[]',
  section_text      TEXT    NOT NULL DEFAULT '',
  page_start        INTEGER NOT NULL,
  page_end          INTEGER NOT NULL,
  block_start       INTEGER NOT NULL,
  block_end         INTEGER NOT NULL,
  block_count       INTEGER NOT NULL,
  has_formula       INTEGER NOT NULL DEFAULT 0,
  char_count        INTEGER NOT NULL,
  text_hash         TEXT    NOT NULL,
  chunker_version   TEXT    NOT NULL,
  layout_version    TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, chunk_key)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks (source_id, ordinal);

-- External-content FTS5 over chunk text + section path. Kept in sync by the
-- triggers below (they also fire for ON DELETE CASCADE from sources).
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
  text,
  section_text,
  content = 'rag_chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts (rowid, text, section_text) VALUES (new.id, new.text, new.section_text);
END;

CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts (rag_chunks_fts, rowid, text, section_text)
  VALUES ('delete', old.id, old.text, old.section_text);
END;

CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE OF text, section_text ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts (rag_chunks_fts, rowid, text, section_text)
  VALUES ('delete', old.id, old.text, old.section_text);
  INSERT INTO rag_chunks_fts (rowid, text, section_text) VALUES (new.id, new.text, new.section_text);
END;

-- Allow chunk vectors in the existing embeddings table (owner_kind 'chunk',
-- owner_id = rag_chunks.id). SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt; rows and ids are copied verbatim.
CREATE TABLE embeddings_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  owner_kind  TEXT    NOT NULL CHECK (owner_kind IN ('concept', 'span', 'chunk')),
  owner_id    INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_kind, owner_id, text_hash, model)
);

INSERT INTO embeddings_v2 (id, source_id, owner_kind, owner_id, text, text_hash, model, dim, vec, created_at)
  SELECT id, source_id, owner_kind, owner_id, text, text_hash, model, dim, vec, created_at FROM embeddings;

DROP TABLE embeddings;
ALTER TABLE embeddings_v2 RENAME TO embeddings;

CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings (source_id, owner_kind, model);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner  ON embeddings (owner_kind, owner_id);
