-- Migration 0012: persist deterministic reject_reasons[] on each candidate.
-- Computed in extractCandidates from boilerplate/broad/fragment/generic/name
-- gates. UI surfaces these as red chips in CandidateReview so the user can
-- see WHY the parser demoted a candidate without recomputing.

ALTER TABLE concept_candidates ADD COLUMN reject_reasons_json TEXT NOT NULL DEFAULT '[]';
