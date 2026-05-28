-- Migration 0018: source-wide PDF annotations.
-- Highlights and sticky notes are user-authored by default, survive tab
-- switches/remounts, and use soft delete so UI undo can restore rows.

CREATE TABLE IF NOT EXISTS pdf_annotations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  concept_id      INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
  scope           TEXT    NOT NULL DEFAULT 'source',
  type            TEXT    NOT NULL,
  created_from    TEXT    NOT NULL,
  page            INTEGER NOT NULL,
  color           TEXT    NOT NULL,
  selected_text   TEXT    NOT NULL DEFAULT '',
  label           TEXT    NOT NULL DEFAULT '',
  note_body       TEXT    NOT NULL DEFAULT '',
  rects_json      TEXT    NOT NULL,
  page_width      REAL,
  page_height     REAL,
  rotation        INTEGER,
  created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_pdf_annotations_source_page_active
  ON pdf_annotations(source_id, page, deleted_at);

CREATE INDEX IF NOT EXISTS idx_pdf_annotations_concept
  ON pdf_annotations(concept_id);
