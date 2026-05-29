-- Migration 0021: explicit "Reviewed" state for the review queue. Review queue
-- membership is now driven by this flag (user clicks Done), decoupled from
-- mastery/compression_stage — completing challenges no longer silently removes
-- a concept from the queue. NULL = still in the queue; a timestamp = reviewed.

ALTER TABLE concepts ADD COLUMN reviewed_at TEXT;
