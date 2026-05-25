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
  };
}

export function createEvidenceRecord(
  db: DatabaseSync,
  input: Omit<EvidenceRecord, 'id' | 'created_at'>,
): EvidenceRecord {
  const result = db
    .prepare(
      `INSERT INTO evidence_records
         (task_id, concept_id, user_response, score, compression_stage,
          gaps_detected, misconceptions_detected, grader_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  const row = db
    .prepare('SELECT * FROM evidence_records WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as RecordRow;
  return rowToRecord(row);
}

export function listRecordsByConcept(db: DatabaseSync, conceptId: number): EvidenceRecord[] {
  return (
    db
      .prepare(
        'SELECT * FROM evidence_records WHERE concept_id = ? ORDER BY created_at DESC',
      )
      .all(conceptId) as unknown as RecordRow[]
  ).map(rowToRecord);
}
