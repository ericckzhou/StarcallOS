-- Migration 0010: persist the LLM topic-fit filter per source.
-- JSON array of candidate IDs the LLM marked keep:true. Empty / NULL = no
-- saved filter; full list shown.

ALTER TABLE sources ADD COLUMN llm_filter_keep_ids_json TEXT;
