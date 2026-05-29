-- Migration 0023: user-authored free-text tags on a concept.
-- Rendered as removable chips in the concept header alongside the read-only
-- evidence-kind chips. JSON array of strings; never written by any LLM pass.

ALTER TABLE concepts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
