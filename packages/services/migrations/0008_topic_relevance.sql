-- Migration 0008: topic anchors per source + topic relevance score per candidate
-- Anchors are derived deterministically at parse time from title + top heading
-- phrases. Relevance score grades each candidate's fit against those anchors.
-- Boilerplate flag catches generic headings (Summary, References, …) regardless
-- of topic.

ALTER TABLE sources ADD COLUMN topic_anchors_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE concept_candidates ADD COLUMN topic_relevance_score        REAL    NOT NULL DEFAULT 1.0;
ALTER TABLE concept_candidates ADD COLUMN topic_relevance_reasons_json TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE concept_candidates ADD COLUMN is_boilerplate               INTEGER NOT NULL DEFAULT 0;
ALTER TABLE concept_candidates ADD COLUMN is_broad                     INTEGER NOT NULL DEFAULT 0;
