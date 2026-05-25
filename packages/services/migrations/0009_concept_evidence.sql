-- Migration 0009: preserve candidate evidence on the promoted concept row.
-- Without this, promoting from deterministic candidates loses the page/quote
-- spans, and the Source viewer falls back to "p.1" for every concept.

ALTER TABLE concepts ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
