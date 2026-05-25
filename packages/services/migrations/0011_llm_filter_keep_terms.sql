-- Migration 0011: rename LLM topic-fit filter storage semantically.
-- 0010 used llm_filter_keep_ids_json, but current decisions are term-keyed.
-- Keep the legacy column for compatibility; new code writes both and reads the
-- terms column first.

ALTER TABLE sources ADD COLUMN llm_filter_keep_terms_json TEXT;

UPDATE sources
SET llm_filter_keep_terms_json = llm_filter_keep_ids_json
WHERE llm_filter_keep_ids_json IS NOT NULL
  AND llm_filter_keep_terms_json IS NULL;
