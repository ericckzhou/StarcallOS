import type { EvidenceScore } from '../core/domain/types';
import { evidenceScoreToFsrsRating, fsrsNext } from './fsrs';

export interface SrsState {
  ease: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  // FSRS card memory (migration 0034). Null under SM-2 / before the first
  // FSRS review.
  stability?: number | null;
  difficulty?: number | null;
}

// ─── Active scheduler ────────────────────────────────────────────────────────
// Process-wide choice set by main from Settings (default SM-2). Kept here so
// record + replay paths (including recompute-on-delete deep in the evidence
// repo) all schedule with the same algorithm without threading settings.

export type SrsScheduler = 'sm2' | 'fsrs';
let activeScheduler: SrsScheduler = 'sm2';

export function setSrsScheduler(s: SrsScheduler): void { activeScheduler = s; }
export function getSrsScheduler(): SrsScheduler { return activeScheduler; }

// Overconfidence penalty: an answer below "understood" given with confidence
// well above its outcome (calibration_gap > threshold) comes back sooner —
// the learner thinks they know it, so verify sooner. Matches the Profile's
// CALIBRATION_TOLERANCE.
export const OVERCONFIDENCE_THRESHOLD = 0.15;
export const OVERCONFIDENCE_INTERVAL_FACTOR = 0.7;

const SM2_CONVERSION_DIFFICULTY = 5;

export interface ScheduleOptions {
  calibrationGap?: number | null;
  lastReviewedAt?: Date | null;
  scheduler?: SrsScheduler;
}

export interface ScheduledSrsReview {
  next: SrsState;
  dueAt: string;
}

export const DEFAULT_SRS_STATE: SrsState = {
  ease: 2.5,
  intervalDays: 0,
  repetitions: 0,
  lapses: 0,
};

const MIN_EASE = 1.3;

export function evidenceScoreToSm2Quality(score: EvidenceScore): number {
  switch (score) {
    case 'understood': return 5;
    case 'recognizes': return 3;
    case 'gap': return 2;
    case 'misconception': return 1;
  }
}

function addDaysUtc(now: Date, days: number): Date {
  const due = new Date(now.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

export function scheduleNextSrsReview(
  state: Partial<SrsState> | null | undefined,
  score: EvidenceScore,
  now = new Date(),
): ScheduledSrsReview {
  const current: SrsState = {
    ease: Math.max(MIN_EASE, state?.ease ?? DEFAULT_SRS_STATE.ease),
    intervalDays: Math.max(0, Math.round(state?.intervalDays ?? 0)),
    repetitions: Math.max(0, Math.round(state?.repetitions ?? 0)),
    lapses: Math.max(0, Math.round(state?.lapses ?? 0)),
  };
  const quality = evidenceScoreToSm2Quality(score);
  const easeDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const ease = Math.max(MIN_EASE, Number((current.ease + easeDelta).toFixed(4)));

  if (quality < 3) {
    const next = {
      ease,
      intervalDays: 1,
      repetitions: 0,
      lapses: current.lapses + 1,
    };
    return { next, dueAt: addDaysUtc(now, next.intervalDays).toISOString() };
  }

  const repetitions = current.repetitions + 1;
  const intervalDays = repetitions === 1
    ? 1
    : repetitions === 2
      ? 6
      : Math.max(1, Math.round(current.intervalDays * ease));

  const next = {
    ease,
    intervalDays,
    repetitions,
    lapses: current.lapses,
  };
  return { next, dueAt: addDaysUtc(now, intervalDays).toISOString() };
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

// Scheduler-agnostic entry point used by record + replay.
export function scheduleReview(
  state: Partial<SrsState> | null | undefined,
  score: EvidenceScore,
  now = new Date(),
  opts: ScheduleOptions = {},
): ScheduledSrsReview {
  const scheduler = opts.scheduler ?? activeScheduler;
  let result: ScheduledSrsReview;
  if (scheduler === 'fsrs') {
    // Existing FSRS memory, or a lazy conversion of an SM-2 card: its current
    // interval is roughly the time to ~90% recall, i.e. FSRS stability; start
    // difficulty mid-scale. No replay is needed when switching schedulers (a
    // replay would drop "✓ Done" reviews, which are not evidence records).
    const reviewed = opts.lastReviewedAt != null;
    const card = !reviewed ? null
      : state?.stability != null && state?.difficulty != null
        ? { stability: state.stability, difficulty: state.difficulty }
        : (state?.intervalDays ?? 0) > 0
          ? { stability: state!.intervalDays!, difficulty: SM2_CONVERSION_DIFFICULTY }
          : null;
    const hasCard = card !== null;
    const elapsed = hasCard ? daysBetween(opts.lastReviewedAt!, now) : 0;
    const rating = evidenceScoreToFsrsRating(score);
    const n = fsrsNext(card, rating, elapsed);
    const next: SrsState = {
      ease: Math.max(MIN_EASE, state?.ease ?? DEFAULT_SRS_STATE.ease), // untouched under FSRS
      intervalDays: n.intervalDays,
      repetitions: rating === 1 ? 0 : (state?.repetitions ?? 0) + 1,
      lapses: (state?.lapses ?? 0) + (rating === 1 && hasCard ? 1 : 0),
      stability: n.stability,
      difficulty: n.difficulty,
    };
    result = { next, dueAt: addDaysUtc(now, next.intervalDays).toISOString() };
  } else {
    const sm2 = scheduleNextSrsReview(state, score, now);
    result = { next: { ...sm2.next, stability: null, difficulty: null }, dueAt: sm2.dueAt };
  }

  const gap = opts.calibrationGap;
  if (gap != null && gap > OVERCONFIDENCE_THRESHOLD && score !== 'understood' && result.next.intervalDays > 1) {
    const intervalDays = Math.max(1, Math.round(result.next.intervalDays * OVERCONFIDENCE_INTERVAL_FACTOR));
    result = { next: { ...result.next, intervalDays }, dueAt: addDaysUtc(now, intervalDays).toISOString() };
  }
  return result;
}

// Persisted concept_srs row (migration 0025). due_at = null means a promoted
// concept has never been scheduled and is therefore immediately due.
export interface ConceptSrs {
  concept_id: number;
  ease: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_grade: EvidenceScore | null;
  stability: number | null;
  difficulty: number | null;
}

export interface SrsReviewInput {
  score: EvidenceScore;
  reviewedAt: Date;
  calibrationGap?: number | null;
}

export interface ReplayedSrs {
  state: SrsState;
  dueAt: string | null;
  lastReviewedAt: string | null;
  lastGrade: EvidenceScore | null;
}

// Replay a concept's full grade history from a fresh card. Used to recompute
// SRS state after an evidence_record is deleted, so deletion is a clean replay
// rather than frozen stale state (mirrors recomputeMasteryForConcept). Each
// step is anchored at its own review time, so the final due date is relative to
// the last surviving review — a long history does not all collapse to "today".
// `reviews` must be in chronological order.
export function replaySrsReviews(reviews: SrsReviewInput[]): ReplayedSrs {
  if (reviews.length === 0) {
    return { state: { ...DEFAULT_SRS_STATE }, dueAt: null, lastReviewedAt: null, lastGrade: null };
  }
  let state: SrsState = { ...DEFAULT_SRS_STATE };
  let dueAt = '';
  let prev: Date | null = null;
  for (const review of reviews) {
    const result = scheduleReview(state, review.score, review.reviewedAt, {
      calibrationGap: review.calibrationGap,
      lastReviewedAt: prev,
    });
    state = result.next;
    dueAt = result.dueAt;
    prev = review.reviewedAt;
  }
  const last = reviews[reviews.length - 1];
  return { state, dueAt, lastReviewedAt: last.reviewedAt.toISOString(), lastGrade: last.score };
}
