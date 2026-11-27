-- Migration 0041: remember the user's rejections across re-extract.
--
-- Rejecting a candidate used to delete its row (or, for prerequisite
-- suggestions, mark it dismissed in a table re-extract wipes), so the next
-- re-extract recreated it and the user had to reject it again. A rejection is
-- a user decision; this table keeps it.
--
--   kind          'concept' | 'relation' | 'misconception' | 'prerequisite'
--   identity_key  the parser identity of what was rejected: a concept
--                 candidate's normalized term, a relation/misconception row's
--                 source_key, or 'from>to|edge_type' for a prerequisite
--                 suggestion. Rows without a parser identity (user-created,
--                 or unknown-origin legacy rows) are deleted without a
--                 rejection record, so no guessed identity ever suppresses
--                 parser output.
--   label         human-readable text for the "Rejected" list
--   payload_json  snapshot of the rejected row, so undo restores it at once
--
-- Re-extract skips parser output whose identity has a rejection record.
-- Undoing a rejection restores the row and deletes the record; it is never
-- irreversible. Source-scoped: deleting the source deletes its rejections.
CREATE TABLE IF NOT EXISTS candidate_rejections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('concept', 'relation', 'misconception', 'prerequisite')),
  identity_key  TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, kind, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_candidate_rejections_source ON candidate_rejections (source_id, kind);
