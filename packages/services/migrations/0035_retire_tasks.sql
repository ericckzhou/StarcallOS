-- Migration 0035: Retire (not delete) graded tasks on Regenerate.
--
-- evidence_records.task_id is declared ON DELETE CASCADE (0003) and foreign
-- keys are enforced, so Regenerate's hard delete of a concept's tasks silently
-- deleted every graded attempt for that concept — contradicting 0013's intent
-- ("History survives task regeneration"). Regenerate now sets retired_at on
-- tasks that have attempts (hidden from the live task list, history kept) and
-- hard-deletes only never-attempted tasks. Rebuilding evidence_records to
-- change the FK was avoided on purpose: this is additive and reversible.
ALTER TABLE evidence_tasks ADD COLUMN retired_at TEXT;
