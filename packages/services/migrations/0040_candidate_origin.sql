-- Migration 0040: ownership for relation and misconception candidates.
--
-- Like equations (0039), these tables mix regenerable parser output with
-- user-authored rows: Candidate Review creates and edits both. Re-extract used
-- to wipe them unconditionally, destroying the user's rows.
--
--   origin            'parser' = deterministic extraction output (regenerable)
--                     'user'   = created by the user
--                     NULL     = unknown (rows that predate this column)
--   user_modified_at  set when the user edits the row
--   source_key        identity of the row as the parser emitted it (set on
--                     parser rows only; computed by the app). An edited parser
--                     row keeps it, so re-extract recognises the parser's next
--                     output as already represented and does not re-add the
--                     original beside the user's edit. Rows without it are
--                     matched on their current content.
--
-- Re-extract deletes only origin = 'parser' rows the user never edited.
-- Unknown-origin rows are preserved: a pre-0040 user row cannot be told apart
-- from parser output, so none is classified as disposable.
ALTER TABLE relation_candidates ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('parser', 'user'));
ALTER TABLE relation_candidates ADD COLUMN user_modified_at TEXT;
ALTER TABLE relation_candidates ADD COLUMN source_key TEXT;

ALTER TABLE misconception_candidates ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('parser', 'user'));
ALTER TABLE misconception_candidates ADD COLUMN user_modified_at TEXT;
ALTER TABLE misconception_candidates ADD COLUMN source_key TEXT;
