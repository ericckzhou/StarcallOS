import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept } from './concepts';
import {
  calculateXpAward,
  progressFromXp,
  createTask,
  createEvidenceRecord,
  deleteEvidenceRecord,
  getMastery,
  recomputeMasteryForConcept,
  recomputeXpForConceptKind,
  listRecordsByConcept,
  getConceptSrs,
  recordSrsReview,
  recomputeSrsForConcept,
  countDueConcepts,
  setConceptSrsDue,
} from './evidence';
import { listReviewQueue } from './concepts';

function setup() {
  const db = openDb(':memory:');
  const src = createSource(db, { filename: 'test.pdf', file_path: '/tmp/test.pdf' });
  createConcept(db, {
    source_id: src.id,
    name: 'Test Concept',
    slug: 'test-concept',
    importance: 'core',
    definition_text: 'A test concept.',
    why_exists: 'Testing.',
    what_breaks: 'Nothing.',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0.5,
    misconception_risk: 0.2,
    centrality_score: 0,
  });
  const concept = db.prepare('SELECT id FROM concepts LIMIT 1').get() as { id: number };
  return { db, conceptId: concept.id };
}

type DB = ReturnType<typeof openDb>;

function makeTask(db: DB, conceptId: number, kind = 'definition', difficulty = 3) {
  return createTask(db, { concept_id: conceptId, kind: kind as never, prompt: `Test ${kind} ${Date.now()}`, difficulty: difficulty as never });
}

function makeRecord(db: DB, conceptId: number, taskId: number, stage: number, score: 'understood' | 'recognizes' | 'gap' = 'gap', difficulty = 3) {
  return createEvidenceRecord(db, {
    task_id: taskId,
    concept_id: conceptId,
    user_response: 'response',
    score,
    compression_stage: stage as never,
    gaps_detected: ['gap 1'],
    misconceptions_detected: [],
    grader_reasoning: null,
    task_prompt_snapshot: `prompt-${taskId}`,
    task_kind_snapshot: 'definition' as never,
    task_difficulty_snapshot: difficulty as never,
  });
}

// ─── calculateXpAward (pure) ──────────────────────────────────────────────────

describe('calculateXpAward', () => {
  it('awards full XP for understood', () => {
    expect(calculateXpAward(5, 'understood')).toBe(100);
    expect(calculateXpAward(3, 'understood')).toBe(60);
  });

  it('scales by score multiplier', () => {
    expect(calculateXpAward(5, 'recognizes')).toBe(60);   // 0.6×
    expect(calculateXpAward(4, 'gap')).toBe(20);           // 0.25×
    expect(calculateXpAward(5, 'misconception')).toBe(10); // 0.1×
  });

  it('returns at least 5 XP for any attempt', () => {
    expect(calculateXpAward(1, 'misconception')).toBeGreaterThanOrEqual(5);
  });
});

// ─── progressFromXp (pure) ────────────────────────────────────────────────────

describe('progressFromXp', () => {
  it('starts at level 1 with 0 XP', () => {
    const p = progressFromXp(0);
    expect(p.level).toBe(1);
    expect(p.progress_ratio).toBe(0);
  });

  it('level increases as XP grows', () => {
    expect(progressFromXp(100).level).toBe(2);
    expect(progressFromXp(400).level).toBe(3);
  });

  it('progress_ratio is between 0 and 1 within a level', () => {
    const p = progressFromXp(150);
    expect(p.progress_ratio).toBeGreaterThan(0);
    expect(p.progress_ratio).toBeLessThan(1);
  });
});

// ─── deleteEvidenceRecord — XP re-award + mastery recompute ───────────────────

describe('deleteEvidenceRecord', () => {
  let db: DB; let conceptId: number;
  beforeEach(() => { ({ db, conceptId } = setup()); });

  it('removes the mastery row when the last record is deleted', () => {
    const task = makeTask(db, conceptId);
    const rec = makeRecord(db, conceptId, task.id, 3);
    recomputeMasteryForConcept(db, conceptId);
    expect(getMastery(db, conceptId)).not.toBeNull();
    deleteEvidenceRecord(db, rec.id);
    expect(getMastery(db, conceptId)).toBeNull();
  });

  it('recomputes mastery to MAX of remaining stages after delete', () => {
    const task = makeTask(db, conceptId);
    const low  = makeRecord(db, conceptId, task.id, 2);
    const high = makeRecord(db, conceptId, task.id, 4);
    recomputeMasteryForConcept(db, conceptId);
    expect(getMastery(db, conceptId)!.compression_stage).toBe(4);
    deleteEvidenceRecord(db, high.id);
    expect(getMastery(db, conceptId)!.compression_stage).toBe(2);
    deleteEvidenceRecord(db, low.id);
    expect(getMastery(db, conceptId)).toBeNull();
  });

  it('re-awards XP to the next-highest-difficulty record in the bucket', () => {
    const task = makeTask(db, conceptId, 'definition', 3);
    const harder = makeRecord(db, conceptId, task.id, 3, 'understood', 5);
    const softer = makeRecord(db, conceptId, task.id, 2, 'recognizes', 2);
    recomputeXpForConceptKind(db, conceptId, 'definition');
    const before = listRecordsByConcept(db, conceptId);
    expect(before.find(r => r.id === harder.id)!.xp_awarded).toBeGreaterThan(0);
    expect(before.find(r => r.id === softer.id)!.xp_awarded).toBe(0);
    deleteEvidenceRecord(db, harder.id);
    const after = listRecordsByConcept(db, conceptId);
    expect(after.find(r => r.id === softer.id)!.xp_awarded).toBeGreaterThan(0);
  });

  it('does not leave any XP stranded after full bucket deletion', () => {
    const task = makeTask(db, conceptId, 'connection', 4);
    const rec = makeRecord(db, conceptId, task.id, 3, 'understood', 4);
    deleteEvidenceRecord(db, rec.id);
    expect(listRecordsByConcept(db, conceptId)).toHaveLength(0);
    expect(getMastery(db, conceptId)).toBeNull();
  });
});

describe('recomputeXpForConceptKind', () => {
  let db: DB; let conceptId: number;
  beforeEach(() => { ({ db, conceptId } = setup()); });

  it('gives all XP to the highest-difficulty record', () => {
    const task = makeTask(db, conceptId, 'definition', 3);
    const r1 = makeRecord(db, conceptId, task.id, 2, 'gap', 2);
    const r2 = makeRecord(db, conceptId, task.id, 3, 'understood', 5);
    recomputeXpForConceptKind(db, conceptId, 'definition');
    const records = listRecordsByConcept(db, conceptId);
    expect(records.find(r => r.id === r2.id)!.xp_awarded).toBe(calculateXpAward(5, 'understood'));
    expect(records.find(r => r.id === r1.id)!.xp_awarded).toBe(0);
  });

  it('is idempotent — running twice gives the same result', () => {
    const task = makeTask(db, conceptId, 'compression', 3);
    makeRecord(db, conceptId, task.id, 2, 'recognizes', 3);
    recomputeXpForConceptKind(db, conceptId, 'compression');
    const first = listRecordsByConcept(db, conceptId).map(r => r.xp_awarded);
    recomputeXpForConceptKind(db, conceptId, 'compression');
    const second = listRecordsByConcept(db, conceptId).map(r => r.xp_awarded);
    expect(first).toEqual(second);
  });
});

// ─── Spaced repetition (concept_srs) ──────────────────────────────────────────

describe('concept_srs scheduling', () => {
  let db: DB;
  let conceptId: number;
  beforeEach(() => {
    ({ db, conceptId } = setup());
  });

  it('treats a freshly promoted concept (no SRS row) as due', () => {
    expect(getConceptSrs(db, conceptId)).toBeNull();
    const queue = listReviewQueue(db);
    expect(queue.find(i => i.concept.id === conceptId)).toBeTruthy();
    expect(queue.find(i => i.concept.id === conceptId)!.due_at).toBeNull();
    expect(countDueConcepts(db)).toBe(1);
  });

  it('recordSrsReview schedules a passing review into the future; card stays listed but not due', () => {
    const card = recordSrsReview(db, conceptId, 'understood');
    expect(card.repetitions).toBe(1);
    expect(card.interval_days).toBe(1);
    expect(card.last_grade).toBe('understood');
    expect(new Date(card.due_at!).getTime()).toBeGreaterThan(Date.now());

    // The queue lists ALL concepts with their due state; a scheduled card stays
    // visible (with a future due_at) rather than disappearing, but is not "due".
    const listed = listReviewQueue(db).find(i => i.concept.id === conceptId);
    expect(listed).toBeTruthy();
    expect(new Date(listed!.due_at!).getTime()).toBeGreaterThan(Date.now());
    expect(countDueConcepts(db)).toBe(0);
  });

  it('a lapse keeps the card due soon and visible', () => {
    recordSrsReview(db, conceptId, 'understood');
    const lapsed = recordSrsReview(db, conceptId, 'misconception');
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.interval_days).toBe(1);
  });

  it('resurfaces an overdue card', () => {
    recordSrsReview(db, conceptId, 'understood');
    expect(countDueConcepts(db)).toBe(0);
    // Force the due date into the past, as if the interval elapsed.
    db.prepare("UPDATE concept_srs SET due_at = '2000-01-01T00:00:00.000Z' WHERE concept_id = ?").run(conceptId);
    expect(countDueConcepts(db)).toBe(1);
    expect(listReviewQueue(db).find(i => i.concept.id === conceptId)).toBeTruthy();
  });

  it('recomputeSrsForConcept replays surviving records and removes the card when none remain', () => {
    const task = makeTask(db, conceptId, 'definition', 3);
    makeRecord(db, conceptId, task.id, 2, 'understood', 3);
    recordSrsReview(db, conceptId, 'understood');
    makeRecord(db, conceptId, task.id, 3, 'understood', 3);
    recordSrsReview(db, conceptId, 'understood');

    // Replay over the two surviving records reproduces a 2-rep card.
    recomputeSrsForConcept(db, conceptId);
    expect(getConceptSrs(db, conceptId)!.repetitions).toBe(2);

    // Delete every record → card is removed → concept reads as fresh/due again.
    for (const rec of listRecordsByConcept(db, conceptId)) deleteEvidenceRecord(db, rec.id);
    expect(getConceptSrs(db, conceptId)).toBeNull();
    expect(countDueConcepts(db)).toBe(1);
  });

  it('setConceptSrsDue overrides only the due date, preserving SM-2 state', () => {
    const advanced = recordSrsReview(db, conceptId, 'understood');
    recordSrsReview(db, conceptId, 'understood'); // rep 2, ease bumped
    const before = getConceptSrs(db, conceptId)!;
    expect(before.repetitions).toBe(2);

    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const after = setConceptSrsDue(db, conceptId, future);
    expect(after.due_at).toBe(future);
    expect(after.repetitions).toBe(before.repetitions); // ease/reps untouched
    expect(after.ease).toBe(before.ease);
    expect(countDueConcepts(db)).toBe(0);
    void advanced;
  });

  it('setConceptSrsDue with null clears the schedule (due now) and seeds a card when absent', () => {
    // No card yet → seeds a default-state card with null due_at.
    const seeded = setConceptSrsDue(db, conceptId, null);
    expect(seeded.due_at).toBeNull();
    expect(seeded.repetitions).toBe(0);
    expect(countDueConcepts(db)).toBe(1);

    // After scheduling out, clearing brings it back to due now.
    recordSrsReview(db, conceptId, 'understood');
    expect(countDueConcepts(db)).toBe(0);
    setConceptSrsDue(db, conceptId, null);
    expect(countDueConcepts(db)).toBe(1);
  });
});
