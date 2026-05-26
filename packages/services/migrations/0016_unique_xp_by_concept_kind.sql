-- Migration 0016: enforce XP uniqueness for historical attempts.
-- Only the highest difficulty attempt for each concept + question kind keeps
-- XP. Repeated attempts of the same kind at the same/lower difficulty keep
-- their history but contribute 0 XP.

UPDATE evidence_records SET xp_awarded = 0;

WITH winners AS (
  SELECT id
    FROM (
      SELECT r.id,
             ROW_NUMBER() OVER (
               PARTITION BY r.concept_id, COALESCE(r.task_kind_snapshot, t.kind, '')
               ORDER BY COALESCE(r.task_difficulty_snapshot, t.difficulty, 3) DESC,
                        r.created_at ASC,
                        r.id ASC
             ) AS rank_for_kind
        FROM evidence_records r
        LEFT JOIN evidence_tasks t ON t.id = r.task_id
    )
   WHERE rank_for_kind = 1
)
UPDATE evidence_records
   SET xp_awarded =
       MAX(5, ROUND(task_difficulty_snapshot * 20 *
         CASE score
           WHEN 'understood' THEN 1.0
           WHEN 'recognizes' THEN 0.6
           WHEN 'gap' THEN 0.25
           ELSE 0.1
         END))
 WHERE id IN (SELECT id FROM winners);
