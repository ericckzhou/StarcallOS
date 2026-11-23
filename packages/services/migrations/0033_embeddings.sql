-- Migration 0033: Local embedding vectors (opt-in, Settings → Embeddings).
--
-- Derived data: safe to wipe (clearDerivedDataForSource deletes a source's
-- rows) and rebuilt incrementally on demand. Vectors come from an
-- OpenAI-compatible /embeddings endpoint (e.g. Ollama nomic-embed-text).
--
--   owner_kind  'concept' — concept name + definition (cross-source related
--                           concept suggestions)
--               'span'    — one evidence quote of a concept (grounding retrieval)
--   owner_id    concepts.id for both kinds (a span row's concept)
--   text_hash   sha256 prefix of the embedded text; unchanged text is never
--               re-embedded, changed text replaces its row
--   model       embedding model id; rows from another model are ignored and
--               replaced on the next index pass
--   vec         little-endian Float32 array, L2-normalized at write time
CREATE TABLE IF NOT EXISTS embeddings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  owner_kind  TEXT    NOT NULL CHECK (owner_kind IN ('concept', 'span')),
  owner_id    INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_kind, owner_id, text_hash, model)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings (source_id, owner_kind, model);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner  ON embeddings (owner_kind, owner_id);
