-- Migration 0010: persist the LLM topic-fit filter per source.
-- The column name became legacy in 0011: current code stores a JSON array of
-- normalized candidate terms in llm_filter_keep_terms_json, while continuing
-- to mirror this column for compatibility. Empty / NULL = no saved filter.

ALTER TABLE sources ADD COLUMN llm_filter_keep_ids_json TEXT;
