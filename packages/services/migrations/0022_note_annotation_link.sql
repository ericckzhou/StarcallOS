-- Migration 0022: optional link from a user note to a PDF highlight.
-- Stores the pdf_annotations.id the note points at. Loose reference (no FK):
-- annotations use soft-delete and the renderer resolves the link against the
-- live annotation list, showing nothing if the target is gone. NULL = unlinked.

ALTER TABLE concept_notes ADD COLUMN linked_annotation_id INTEGER;
