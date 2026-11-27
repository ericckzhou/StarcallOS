-- Migration 0038: record how a concept came to exist.
--
--   manual    created by the user (Add concept)
--   promoted  promoted from a deterministic candidate
--   llm       written by LLM extraction (candidate_gated / full modes)
--   NULL      unknown (rows that predate this column)
--
-- Re-extract (clearDerivedDataForSource) may only delete 'llm' concepts that
-- carry no user-owned data. NULL means "origin cannot be established", and
-- such rows are always preserved: a manual concept from before this migration
-- must never be classified as disposable.
--
-- The backfill is deliberately conservative. Only rows whose provenance is
-- certain are labelled: a non-empty evidence_json snapshot is written solely by
-- candidate promotion. Nothing is backfilled as 'llm' or 'manual'.
ALTER TABLE concepts ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('manual', 'promoted', 'llm'));

-- Set whenever the user edits a concept (rename, narrative fields, importance,
-- tags, constellations, evidence spans). Once a user has modified generated
-- content it is no longer disposable: re-extract never deletes a concept with
-- this set, whatever its origin. LLM enrichment does not set it.
ALTER TABLE concepts ADD COLUMN user_modified_at TEXT;

UPDATE concepts
   SET origin = 'promoted'
 WHERE evidence_json IS NOT NULL
   AND evidence_json NOT IN ('', '[]');
