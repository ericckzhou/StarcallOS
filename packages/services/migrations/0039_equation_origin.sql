-- Migration 0039: record whether an equation row is regenerable parser output
-- or user-owned. equation_candidates mixes both: the deterministic parser
-- writes it on every extraction, and users add equations from Candidate Review
-- and from a concept's Overview. Re-extract used to wipe the whole table for
-- the source, destroying user equations even on preserved concepts.
--
--   origin            'parser' = deterministic extraction output (regenerable)
--                     'user'   = created by the user
--                     NULL     = unknown (rows that predate this column)
--   user_modified_at  set when the user edits the row
--   source_latex      the LaTeX the parser originally emitted (parser rows and
--                     legacy rows). Used only to recognise a re-extracted
--                     equation as one that already exists, so an edited or
--                     preserved equation is not re-inserted as a duplicate.
--
-- Re-extract deletes only origin = 'parser' rows the user never edited.
-- Unknown-origin rows are preserved: a pre-0039 user equation cannot be told
-- apart from parser output, so none is classified as disposable.
ALTER TABLE equation_candidates ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('parser', 'user'));
ALTER TABLE equation_candidates ADD COLUMN user_modified_at TEXT;
ALTER TABLE equation_candidates ADD COLUMN source_latex TEXT;

-- Legacy rows: whatever LaTeX they hold now is the best available key for
-- matching the parser's next output (an already-edited legacy row simply
-- won't match, and its parser original reappears as a new candidate).
UPDATE equation_candidates SET source_latex = latex;
