-- Migration 0017: deterministic candidate score metadata

ALTER TABLE concept_candidates ADD COLUMN typography_score REAL NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN signal_score     REAL NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN quality_score    REAL NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN context_score    REAL NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN final_score      REAL NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN labels_json      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE concept_candidates ADD COLUMN typography_signals_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE concept_candidates ADD COLUMN context_snippet  TEXT NOT NULL DEFAULT '';
ALTER TABLE concept_candidates ADD COLUMN parser_diagnostics_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_concept_candidates_final_score
  ON concept_candidates(source_id, final_score DESC);
