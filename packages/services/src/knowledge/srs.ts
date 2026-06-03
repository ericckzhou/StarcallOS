import type { EvidenceScore } from '../core/domain/types';

export interface SrsState {
  ease: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
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
}

export interface SrsReviewInput {
  score: EvidenceScore;
  reviewedAt: Date;
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
  for (const review of reviews) {
    const result = scheduleNextSrsReview(state, review.score, review.reviewedAt);
    state = result.next;
    dueAt = result.dueAt;
  }
  const last = reviews[reviews.length - 1];
  return { state, dueAt, lastReviewedAt: last.reviewedAt.toISOString(), lastGrade: last.score };
}
