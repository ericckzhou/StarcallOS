-- Migration 0011: deterministic concept_score (0–1) per candidate.
-- Computed inline by extractCandidates from signals already collected:
--   heading*0.35 + domain*0.25 + localCtx*0.20 + recurrence*0.10 + phrase*0.10
-- Default 0 so legacy rows sort lowest until re-extracted.

ALTER TABLE concept_candidates ADD COLUMN concept_score REAL NOT NULL DEFAULT 0;
CREATE INDEX idx_concept_candidates_score ON concept_candidates(source_id, concept_score DESC);
