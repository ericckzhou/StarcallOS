-- Migration 0015: XP metadata for graded challenge attempts.
-- Difficulty is snapshotted with prompt/kind so History survives task
-- regeneration. XP is awarded once per concept + task kind, and only when
-- the attempt beats the previous highest XP-earning difficulty for that kind.

ALTER TABLE evidence_records ADD COLUMN task_difficulty_snapshot INTEGER CHECK (task_difficulty_snapshot BETWEEN 1 AND 5);
ALTER TABLE evidence_records ADD COLUMN xp_awarded INTEGER NOT NULL DEFAULT 0;

UPDATE evidence_records
   SET task_difficulty_snapshot = (
         SELECT difficulty FROM evidence_tasks t WHERE t.id = evidence_records.task_id
       )
 WHERE task_difficulty_snapshot IS NULL;

UPDATE evidence_records
   SET task_difficulty_snapshot = 3
 WHERE task_difficulty_snapshot IS NULL;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY concept_id, COALESCE(task_kind_snapshot, '')
           ORDER BY task_difficulty_snapshot DESC, created_at ASC, id ASC
         ) AS rank_for_kind
    FROM evidence_records
)
UPDATE evidence_records
   SET xp_awarded =
       CASE
         WHEN (SELECT rank_for_kind FROM ranked WHERE ranked.id = evidence_records.id) = 1
         THEN MAX(5, ROUND(task_difficulty_snapshot * 20 *
           CASE score
             WHEN 'understood' THEN 1.0
             WHEN 'recognizes' THEN 0.6
             WHEN 'gap' THEN 0.25
             ELSE 0.1
           END))
         ELSE 0
       END
 WHERE xp_awarded = 0;
