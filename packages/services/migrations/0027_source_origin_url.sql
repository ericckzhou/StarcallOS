-- Migration 0027: remember the web origin of a URL-imported source so the UI
-- can offer an "Open original" link back to the live page. NULL for PDFs, text,
-- and document imports.

ALTER TABLE sources ADD COLUMN origin_url TEXT;
