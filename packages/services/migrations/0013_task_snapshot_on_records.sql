-- Migration 0013: denormalize the task prompt + kind onto evidence_records
-- so History survives task regeneration / deletion. Stored at grade time,
-- never updated thereafter.

ALTER TABLE evidence_records ADD COLUMN task_prompt_snapshot TEXT;
ALTER TABLE evidence_records ADD COLUMN task_kind_snapshot   TEXT;
