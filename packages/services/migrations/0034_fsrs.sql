-- Migration 0034: FSRS card memory on concept_srs.
--
-- Settings → Review scheduler picks SM-2 (default) or FSRS-5. Under FSRS each
-- card carries stability (days until recall drops to 90%) and difficulty
-- (1..10). Both are NULL under SM-2 and on cards never reviewed under FSRS.
-- Switching to FSRS converts lazily: an SM-2 card's next review seeds stability
-- from its current interval (see scheduleReview), so no backfill is needed.
ALTER TABLE concept_srs ADD COLUMN stability REAL;
ALTER TABLE concept_srs ADD COLUMN difficulty REAL;
