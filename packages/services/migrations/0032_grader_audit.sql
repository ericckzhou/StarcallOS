-- Migration 0032: Grader audit trail on evidence records.
--
-- Stores what produced each grade so old attempts can be re-scored or audited
-- when the grader contract or model changes. Intrinsic to a single attempt
-- (like 0029/0030 columns): no recompute on delete/replay. All NULL on legacy
-- records graded before this migration.
--
--   grader_output        JSON: the validated wire output(s) of the grader call.
--                        An array when self-consistency sampled more than once.
--   grader_prompt_hash   first 16 hex of sha256(GRADER_SYSTEM) at grade time.
--   grader_model         provider/model id, e.g. "anthropic/claude-sonnet-4-6".
--   grader_contract      CONTRACT_VERSION at grade time.
--   grade_samples        number of grader samples aggregated (1 = single call).
ALTER TABLE evidence_records ADD COLUMN grader_output TEXT;
ALTER TABLE evidence_records ADD COLUMN grader_prompt_hash TEXT;
ALTER TABLE evidence_records ADD COLUMN grader_model TEXT;
ALTER TABLE evidence_records ADD COLUMN grader_contract TEXT;
ALTER TABLE evidence_records ADD COLUMN grade_samples INTEGER;
