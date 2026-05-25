-- Migration 0014: user-authored free-form notes attached to a concept.
-- Renders below the LLM-managed Overview fields. Created and edited
-- exclusively by the user; never written or overwritten by any LLM pass
-- or by re-extraction. Cascades on concept delete; survives everything else.

CREATE TABLE IF NOT EXISTS concept_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  heading     TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_concept_notes_concept_position
  ON concept_notes(concept_id, position);
