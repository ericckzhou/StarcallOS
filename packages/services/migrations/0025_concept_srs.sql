-- Migration 0025: concept-level spaced repetition state.
-- NULL due_at means a promoted concept is new and immediately due.

CREATE TABLE IF NOT EXISTS concept_srs (
  concept_id       INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  ease             REAL    NOT NULL DEFAULT 2.5 CHECK (ease >= 1.3),
  interval_days    INTEGER NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  repetitions      INTEGER NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
  lapses           INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  due_at           TEXT,
  last_reviewed_at TEXT,
  last_grade       TEXT CHECK (last_grade IS NULL OR last_grade IN ('understood','recognizes','gap','misconception'))
);

CREATE INDEX IF NOT EXISTS idx_concept_srs_due_at ON concept_srs(due_at);

INSERT INTO concept_srs (
  concept_id,
  ease,
  interval_days,
  repetitions,
  lapses,
  due_at,
  last_reviewed_at,
  last_grade
)
SELECT
  c.id,
  CASE
    WHEN latest.score = 'understood' THEN 2.6
    WHEN latest.score = 'recognizes' THEN 2.36
    WHEN latest.score = 'gap' THEN 2.18
    WHEN latest.score = 'misconception' THEN 1.96
    ELSE 2.5
  END,
  CASE
    WHEN latest.score IN ('understood','recognizes') AND stats.attempts >= 2 THEN 6
    WHEN latest.score IS NOT NULL THEN 1
    ELSE 0
  END,
  CASE
    WHEN latest.score IN ('understood','recognizes') THEN MIN(stats.attempts, 2)
    ELSE 0
  END,
  COALESCE(stats.lapses, 0),
  CASE
    WHEN latest.last_reviewed_at IS NULL THEN NULL
    WHEN latest.score IN ('understood','recognizes') AND stats.attempts >= 2 THEN datetime(latest.last_reviewed_at, '+6 days')
    ELSE datetime(latest.last_reviewed_at, '+1 day')
  END,
  latest.last_reviewed_at,
  latest.score
FROM concepts c
LEFT JOIN (
  SELECT concept_id,
         COUNT(*) AS attempts,
         SUM(CASE WHEN score IN ('gap','misconception') THEN 1 ELSE 0 END) AS lapses
    FROM evidence_records
   GROUP BY concept_id
) stats ON stats.concept_id = c.id
LEFT JOIN (
  SELECT r.concept_id, r.score, r.created_at AS last_reviewed_at
    FROM evidence_records r
    JOIN (
      SELECT concept_id, MAX(created_at || printf('%012d', id)) AS max_key
        FROM evidence_records
       GROUP BY concept_id
    ) pick ON pick.concept_id = r.concept_id
          AND pick.max_key = r.created_at || printf('%012d', r.id)
) latest ON latest.concept_id = c.id
ON CONFLICT(concept_id) DO NOTHING;
