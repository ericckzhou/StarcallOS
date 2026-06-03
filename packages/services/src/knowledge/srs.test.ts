import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SRS_STATE,
  evidenceScoreToSm2Quality,
  replaySrsReviews,
  scheduleNextSrsReview,
} from './srs';

const NOW = new Date('2026-06-03T12:00:00.000Z');

describe('scheduleNextSrsReview', () => {
  it('maps grader scores to SM-2 qualities', () => {
    expect(evidenceScoreToSm2Quality('understood')).toBe(5);
    expect(evidenceScoreToSm2Quality('recognizes')).toBe(3);
    expect(evidenceScoreToSm2Quality('gap')).toBe(2);
    expect(evidenceScoreToSm2Quality('misconception')).toBe(1);
  });

  it('graduates successful reviews through the first SM-2 intervals', () => {
    const first = scheduleNextSrsReview(DEFAULT_SRS_STATE, 'understood', NOW);
    expect(first.next.repetitions).toBe(1);
    expect(first.next.intervalDays).toBe(1);
    expect(first.dueAt).toBe('2026-06-04T12:00:00.000Z');

    const second = scheduleNextSrsReview(first.next, 'understood', NOW);
    expect(second.next.repetitions).toBe(2);
    expect(second.next.intervalDays).toBe(6);

    const third = scheduleNextSrsReview(second.next, 'understood', NOW);
    expect(third.next.repetitions).toBe(3);
    expect(third.next.intervalDays).toBeGreaterThan(6);
  });

  it('resets repetitions and counts a lapse on failed reviews', () => {
    const reviewed = { ease: 2.5, intervalDays: 10, repetitions: 4, lapses: 0 };
    const next = scheduleNextSrsReview(reviewed, 'gap', NOW);
    expect(next.next.repetitions).toBe(0);
    expect(next.next.intervalDays).toBe(1);
    expect(next.next.lapses).toBe(1);
  });

  it('never drops ease below the floor', () => {
    let state = { ease: 1.31, intervalDays: 1, repetitions: 1, lapses: 0 };
    for (let i = 0; i < 5; i += 1) {
      state = scheduleNextSrsReview(state, 'misconception', NOW).next;
    }
    expect(state.ease).toBe(1.3);
  });

  it('is deterministic for the same state, score, and timestamp', () => {
    const state = { ease: 2.2, intervalDays: 4, repetitions: 3, lapses: 1 };
    const a = scheduleNextSrsReview(state, 'recognizes', NOW);
    const b = scheduleNextSrsReview(state, 'recognizes', NOW);
    expect(a).toEqual(b);
  });
});

describe('replaySrsReviews', () => {
  it('returns a fresh, unscheduled card for empty history', () => {
    const result = replaySrsReviews([]);
    expect(result.state).toEqual(DEFAULT_SRS_STATE);
    expect(result.dueAt).toBeNull();
    expect(result.lastReviewedAt).toBeNull();
    expect(result.lastGrade).toBeNull();
  });

  it('matches a step-by-step fold over the same chronological grades', () => {
    const reviews = [
      { score: 'understood' as const, reviewedAt: new Date('2026-05-01T00:00:00.000Z') },
      { score: 'understood' as const, reviewedAt: new Date('2026-05-02T00:00:00.000Z') },
      { score: 'recognizes' as const, reviewedAt: new Date('2026-05-08T00:00:00.000Z') },
    ];
    const replayed = replaySrsReviews(reviews);

    let state = DEFAULT_SRS_STATE;
    let dueAt = '';
    for (const r of reviews) {
      const step = scheduleNextSrsReview(state, r.score, r.reviewedAt);
      state = step.next;
      dueAt = step.dueAt;
    }
    expect(replayed.state).toEqual(state);
    expect(replayed.dueAt).toBe(dueAt);
    expect(replayed.lastReviewedAt).toBe('2026-05-08T00:00:00.000Z');
    expect(replayed.lastGrade).toBe('recognizes');
  });

  it('anchors the final due date on the last review, not the present', () => {
    // Two passes: rep 2 ⇒ 6-day interval ⇒ due six days after the last review.
    const reviews = [
      { score: 'understood' as const, reviewedAt: new Date('2026-01-01T00:00:00.000Z') },
      { score: 'understood' as const, reviewedAt: new Date('2026-01-02T00:00:00.000Z') },
    ];
    const replayed = replaySrsReviews(reviews);
    expect(replayed.state.intervalDays).toBe(6);
    expect(replayed.dueAt).toBe('2026-01-08T00:00:00.000Z');
  });

  it('reflects lapses in the replayed state', () => {
    const reviews = [
      { score: 'understood' as const, reviewedAt: new Date('2026-01-01T00:00:00.000Z') },
      { score: 'gap' as const, reviewedAt: new Date('2026-01-02T00:00:00.000Z') },
    ];
    const replayed = replaySrsReviews(reviews);
    expect(replayed.state.repetitions).toBe(0);
    expect(replayed.state.lapses).toBe(1);
    expect(replayed.state.intervalDays).toBe(1);
  });
});
