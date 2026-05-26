import type { DatabaseSync } from '../../core/infra/sqlite';
import type {
  Misconception,
  MisconceptionStatus,
  EvidenceTask,
  EvidenceKind,
  Mastery,
  CompressionStage,
  EvidenceRecord,
  EvidenceScore,
  SemanticChunk,
  BlockType,
} from '../../core/domain/types';

// ─── Semantic Chunks ──────────────────────────────────────────────────────────

interface ChunkRow {
  id: number | bigint;
  source_id: number | bigint;
  content: string;
  page_start: number;
  page_end: number;
  block_type: string;
  section_path: string;
  claim: string | null;
  assumptions: string;
  example_quote: string | null;
  created_at: string;
}

function rowToChunk(row: ChunkRow): SemanticChunk {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    content: row.content,
    page_start: row.page_start,
    page_end: row.page_end,
    block_type: row.block_type as BlockType,
    section_path: JSON.parse(row.section_path) as string[],
    claim: row.claim ?? null,
    assumptions: JSON.parse(row.assumptions) as string[],
    example_quote: row.example_quote ?? null,
    created_at: row.created_at,
  };
}

export function createChunk(
  db: DatabaseSync,
  input: Omit<SemanticChunk, 'id' | 'created_at'>,
): SemanticChunk {
  const result = db
    .prepare(
      `INSERT INTO semantic_chunks
         (source_id, content, page_start, page_end, block_type,
          section_path, claim, assumptions, example_quote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_id,
      input.content,
      input.page_start,
      input.page_end,
      input.block_type,
      JSON.stringify(input.section_path),
      input.claim,
      JSON.stringify(input.assumptions),
      input.example_quote,
    );
  const row = db
    .prepare('SELECT * FROM semantic_chunks WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as ChunkRow;
  return rowToChunk(row);
}

export function listChunksBySource(db: DatabaseSync, sourceId: number): SemanticChunk[] {
  return (
    db
      .prepare('SELECT * FROM semantic_chunks WHERE source_id = ? ORDER BY page_start')
      .all(sourceId) as unknown as ChunkRow[]
  ).map(rowToChunk);
}

// ─── Misconceptions ───────────────────────────────────────────────────────────

interface MisconceptionRow {
  id: number | bigint;
  concept_id: number | bigint;
  description: string;
  why_think_it: string;
  why_wrong: string;
  test_prompt: string;
  seen_count: number;
  status: string;
  created_at: string;
}

function rowToMisconception(row: MisconceptionRow): Misconception {
  return {
    id: Number(row.id),
    concept_id: Number(row.concept_id),
    description: row.description,
    why_think_it: row.why_think_it,
    why_wrong: row.why_wrong,
    test_prompt: row.test_prompt,
    seen_count: row.seen_count,
    status: row.status as MisconceptionStatus,
    created_at: row.created_at,
  };
}

export function createMisconception(
  db: DatabaseSync,
  input: Omit<Misconception, 'id' | 'seen_count' | 'status' | 'created_at'>,
): Misconception {
  const result = db
    .prepare(
      `INSERT INTO misconceptions
         (concept_id, description, why_think_it, why_wrong, test_prompt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.concept_id,
      input.description,
      input.why_think_it,
      input.why_wrong,
      input.test_prompt,
    );
  const row = db
    .prepare('SELECT * FROM misconceptions WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as MisconceptionRow;
  return rowToMisconception(row);
}

export function incrementMisconceptionSeen(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE misconceptions SET seen_count = seen_count + 1 WHERE id = ?').run(id);
}

export function resolveMisconception(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE misconceptions SET status = 'resolved' WHERE id = ?`).run(id);
}

export function listMisconceptionsByConcept(
  db: DatabaseSync,
  conceptId: number,
): Misconception[] {
  return (
    db
      .prepare(
        'SELECT * FROM misconceptions WHERE concept_id = ? ORDER BY seen_count DESC',
      )
      .all(conceptId) as unknown as MisconceptionRow[]
  ).map(rowToMisconception);
}

// ─── Evidence Tasks ───────────────────────────────────────────────────────────

interface TaskRow {
  id: number | bigint;
  concept_id: number | bigint;
  kind: string;
  prompt: string;
  difficulty: number;
  created_at: string;
}

function rowToTask(row: TaskRow): EvidenceTask {
  return {
    id: Number(row.id),
    concept_id: Number(row.concept_id),
    kind: row.kind as EvidenceKind,
    prompt: row.prompt,
    difficulty: row.difficulty as 1 | 2 | 3 | 4 | 5,
    created_at: row.created_at,
  };
}

export function createTask(
  db: DatabaseSync,
  input: Omit<EvidenceTask, 'id' | 'created_at'>,
): EvidenceTask {
  const result = db
    .prepare(
      `INSERT INTO evidence_tasks (concept_id, kind, prompt, difficulty)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.concept_id,
      input.kind,
      input.prompt,
      Math.max(1, Math.min(5, Math.round(input.difficulty || 3))),
    );
  const row = db
    .prepare('SELECT * FROM evidence_tasks WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as TaskRow;
  return rowToTask(row);
}

export function listTasksByConcept(db: DatabaseSync, conceptId: number): EvidenceTask[] {
  return (
    db
      .prepare('SELECT * FROM evidence_tasks WHERE concept_id = ? ORDER BY kind')
      .all(conceptId) as unknown as TaskRow[]
  ).map(rowToTask);
}

export function deleteTasksForConcept(db: DatabaseSync, conceptId: number): void {
  db.prepare('DELETE FROM evidence_tasks WHERE concept_id = ?').run(conceptId);
}

// ─── Mastery ──────────────────────────────────────────────────────────────────

interface MasteryRow {
  concept_id: number | bigint;
  compression_stage: number;
  last_updated: string;
}

function rowToMastery(row: MasteryRow): Mastery {
  return {
    concept_id: Number(row.concept_id),
    compression_stage: row.compression_stage as CompressionStage,
    last_updated: row.last_updated,
  };
}

export function upsertMastery(
  db: DatabaseSync,
  conceptId: number,
  stage: CompressionStage,
): Mastery {
  db.prepare(
    `INSERT INTO mastery (concept_id, compression_stage, last_updated)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(concept_id) DO UPDATE SET
       compression_stage = excluded.compression_stage,
       last_updated = excluded.last_updated`,
  ).run(conceptId, stage);
  const row = db
    .prepare('SELECT * FROM mastery WHERE concept_id = ?')
    .get(conceptId) as unknown as MasteryRow;
  return rowToMastery(row);
}

export function getMastery(db: DatabaseSync, conceptId: number): Mastery | null {
  const row = db
    .prepare('SELECT * FROM mastery WHERE concept_id = ?')
    .get(conceptId) as unknown as MasteryRow | undefined;
  return row != null ? rowToMastery(row) : null;
}

export function listMasteryBySource(db: DatabaseSync, sourceId: number): Mastery[] {
  return (
    db
      .prepare(
        `SELECT m.* FROM mastery m
         JOIN concepts c ON c.id = m.concept_id
         WHERE c.source_id = ?`,
      )
      .all(sourceId) as unknown as MasteryRow[]
  ).map(rowToMastery);
}

// ─── Evidence Records ─────────────────────────────────────────────────────────

interface RecordRow {
  id: number | bigint;
  task_id: number | bigint;
  concept_id: number | bigint;
  user_response: string;
  score: string;
  compression_stage: number;
  gaps_detected: string;
  misconceptions_detected: string;
  grader_reasoning: string | null;
  created_at: string;
  task_prompt_snapshot: string | null;
  task_kind_snapshot: string | null;
  task_difficulty_snapshot: number | null;
  xp_awarded: number;
}

function rowToRecord(row: RecordRow): EvidenceRecord {
  return {
    id: Number(row.id),
    task_id: Number(row.task_id),
    concept_id: Number(row.concept_id),
    user_response: row.user_response,
    score: row.score as EvidenceScore,
    compression_stage: row.compression_stage as CompressionStage,
    gaps_detected: JSON.parse(row.gaps_detected) as string[],
    misconceptions_detected: JSON.parse(row.misconceptions_detected) as string[],
    grader_reasoning: row.grader_reasoning,
    created_at: row.created_at,
    task_prompt_snapshot: row.task_prompt_snapshot ?? null,
    task_kind_snapshot: row.task_kind_snapshot ?? null,
    task_difficulty_snapshot: row.task_difficulty_snapshot as 1 | 2 | 3 | 4 | 5 | null,
    xp_awarded: row.xp_awarded,
  };
}

export function calculateXpAward(difficulty: number, score: EvidenceScore): number {
  const clampedDifficulty = Math.max(1, Math.min(5, Math.round(difficulty || 3)));
  const multiplier = score === 'understood'
    ? 1
    : score === 'recognizes'
      ? 0.6
      : score === 'gap'
        ? 0.25
        : 0.1;
  return Math.max(5, Math.round(clampedDifficulty * 20 * multiplier));
}

export function calculateEligibleXpAward(
  db: DatabaseSync,
  conceptId: number,
  taskKind: EvidenceKind,
  difficulty: number,
  score: EvidenceScore,
): number {
  const row = db
    .prepare(
      `SELECT MAX(COALESCE(r.task_difficulty_snapshot, t.difficulty, 0)) AS max_difficulty
         FROM evidence_records r
         LEFT JOIN evidence_tasks t ON t.id = r.task_id
        WHERE r.concept_id = ?
          AND COALESCE(r.task_kind_snapshot, t.kind) = ?
          AND COALESCE(r.xp_awarded, 0) > 0`,
    )
    .get(conceptId, taskKind) as unknown as { max_difficulty: number | bigint | null } | undefined;
  const priorMax = Number(row?.max_difficulty ?? 0);
  const currentDifficulty = Math.max(1, Math.min(5, Math.round(difficulty || 3)));
  return currentDifficulty > priorMax ? calculateXpAward(currentDifficulty, score) : 0;
}

export function createEvidenceRecord(
  db: DatabaseSync,
  input: Omit<EvidenceRecord, 'id' | 'created_at' | 'task_difficulty_snapshot' | 'xp_awarded'> &
    Partial<Pick<EvidenceRecord, 'task_difficulty_snapshot' | 'xp_awarded'>>,
): EvidenceRecord {
  const difficulty = input.task_difficulty_snapshot ?? 3;
  const xpAwarded = input.xp_awarded ?? calculateXpAward(difficulty, input.score);
  const result = db
    .prepare(
      `INSERT INTO evidence_records
         (task_id, concept_id, user_response, score, compression_stage,
          gaps_detected, misconceptions_detected, grader_reasoning,
          task_prompt_snapshot, task_kind_snapshot, task_difficulty_snapshot,
          xp_awarded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_id,
      input.concept_id,
      input.user_response,
      input.score,
      input.compression_stage,
      JSON.stringify(input.gaps_detected),
      JSON.stringify(input.misconceptions_detected),
      input.grader_reasoning,
      input.task_prompt_snapshot ?? null,
      input.task_kind_snapshot ?? null,
      difficulty,
      xpAwarded,
    );
  const row = db
    .prepare('SELECT * FROM evidence_records WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as RecordRow;
  return rowToRecord(row);
}

export function deleteEvidenceRecord(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM evidence_records WHERE id = ?').run(id);
}

export function listRecordsByConcept(db: DatabaseSync, conceptId: number): EvidenceRecord[] {
  // LEFT JOIN evidence_tasks so legacy records (created before the snapshot
  // columns existed) still display the question — falling back to the live
  // task row when the snapshot is null. If the task was hard-deleted via
  // Regenerate, both sides are null and the UI hides the prompt block.
  return (
    db
      .prepare(
        `SELECT r.*,
                COALESCE(r.task_prompt_snapshot, t.prompt) AS task_prompt_snapshot,
                COALESCE(r.task_kind_snapshot,   t.kind)   AS task_kind_snapshot,
                COALESCE(r.task_difficulty_snapshot, t.difficulty, 3) AS task_difficulty_snapshot,
                COALESCE(r.xp_awarded, 0) AS xp_awarded
           FROM evidence_records r
           LEFT JOIN evidence_tasks t ON t.id = r.task_id
          WHERE r.concept_id = ?
          ORDER BY r.created_at DESC`,
      )
      .all(conceptId) as unknown as RecordRow[]
  ).map(rowToRecord);
}

export interface StudyProgress {
  total_xp: number;
  level: number;
  current_level_xp: number;
  next_level_xp: number;
  progress_ratio: number;
  challenges_completed: number;
  difficulty_counts: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function progressFromXp(
  totalXp: number,
  challengesCompleted = 0,
  difficultyCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
): StudyProgress {
  const level = Math.floor(Math.sqrt(Math.max(0, totalXp) / 100)) + 1;
  const currentLevelXp = (level - 1) * (level - 1) * 100;
  const nextLevelXp = level * level * 100;
  return {
    total_xp: totalXp,
    level,
    current_level_xp: currentLevelXp,
    next_level_xp: nextLevelXp,
    progress_ratio: nextLevelXp > currentLevelXp
      ? (totalXp - currentLevelXp) / (nextLevelXp - currentLevelXp)
      : 1,
    challenges_completed: challengesCompleted,
    difficulty_counts: difficultyCounts,
  };
}

export function getStudyProgress(db: DatabaseSync): StudyProgress {
  const xpRow = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(xp_awarded, 0)), 0) AS total_xp
         FROM evidence_records`,
    )
    .get() as unknown as { total_xp: number | bigint } | undefined;
  const challengeRow = db
    .prepare('SELECT COUNT(*) AS total FROM evidence_records')
    .get() as unknown as { total: number | bigint } | undefined;
  const difficultyRows = db
    .prepare(
      `SELECT COALESCE(r.task_difficulty_snapshot, t.difficulty, 3) AS difficulty,
              COUNT(*) AS total
         FROM evidence_records r
         LEFT JOIN evidence_tasks t ON t.id = r.task_id
        GROUP BY COALESCE(r.task_difficulty_snapshot, t.difficulty, 3)`,
    )
    .all() as unknown as Array<{ difficulty: number | bigint; total: number | bigint }>;
  const difficultyCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of difficultyRows) {
    const difficulty = Math.max(1, Math.min(5, Number(row.difficulty))) as 1 | 2 | 3 | 4 | 5;
    difficultyCounts[difficulty] = Number(row.total);
  }
  return progressFromXp(Number(xpRow?.total_xp ?? 0), Number(challengeRow?.total ?? 0), difficultyCounts);
}
