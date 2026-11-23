import { describe, expect, it, afterEach } from 'vitest';
import { fsrsInterval, fsrsNext, retrievability } from './fsrs';
import { replaySrsReviews, scheduleReview, setSrsScheduler, OVERCONFIDENCE_INTERVAL_FACTOR } from './srs';
import { orderBlockedLast } from './repos/concepts';

afterEach(() => setSrsScheduler('sm2'));

describe('FSRS-5 core', () => {
  it('has R(S,S)=0.9 and interval(S)=S at 90% retention', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 5);
    expect(fsrsInterval(10)).toBe(10);
  });

  it('grows stability on success, shrinks it on lapse, Hard < Good', () => {
    const first = fsrsNext(null, 3, 0);
    const good = fsrsNext(first, 3, first.intervalDays);
    const hard = fsrsNext(first, 2, first.intervalDays);
    const again = fsrsNext(good, 1, good.intervalDays);
    expect(good.stability).toBeGreaterThan(first.stability);
    expect(hard.stability).toBeLessThan(good.stability);
    expect(again.stability).toBeLessThan(good.stability);
    expect(again.intervalDays).toBe(1);
    expect(again.difficulty).toBeGreaterThan(good.difficulty);
  });
});

describe('scheduleReview', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('uses FSRS when active and seeds a lazy conversion from the SM-2 interval', () => {
    setSrsScheduler('fsrs');
    const sm2Card = { ease: 2.5, intervalDays: 15, repetitions: 3, lapses: 0 };
    const r = scheduleReview(sm2Card, 'understood', now, { lastReviewedAt: new Date('2026-05-17T00:00:00Z') });
    expect(r.next.stability).toBeGreaterThan(15);
    expect(r.next.intervalDays).toBeGreaterThan(15);
    expect(r.next.ease).toBe(2.5);
  });

  it('first FSRS review starts a fresh card', () => {
    const r = scheduleReview(null, 'understood', now, { scheduler: 'fsrs' });
    expect(r.next).toMatchObject({ repetitions: 1, lapses: 0 });
    expect(r.next.stability).toBeCloseTo(3.173);
  });

  it('shortens the interval for an overconfident non-understood answer, under either scheduler', () => {
    const card = { ease: 2.5, intervalDays: 10, repetitions: 3, lapses: 0 };
    for (const scheduler of ['sm2', 'fsrs'] as const) {
      const opts = { scheduler, lastReviewedAt: new Date('2026-05-22T00:00:00Z') };
      const base = scheduleReview(card, 'recognizes', now, opts);
      const over = scheduleReview(card, 'recognizes', now, { ...opts, calibrationGap: 0.5 });
      const under = scheduleReview(card, 'recognizes', now, { ...opts, calibrationGap: -0.4 });
      expect(over.next.intervalDays).toBe(Math.max(1, Math.round(base.next.intervalDays * OVERCONFIDENCE_INTERVAL_FACTOR)));
      expect(under.next.intervalDays).toBe(base.next.intervalDays);
    }
    // A correct "understood" answer is never penalized for confidence.
    const u1 = scheduleReview(card, 'understood', now, { calibrationGap: 0.5, lastReviewedAt: now });
    const u2 = scheduleReview(card, 'understood', now, { lastReviewedAt: now });
    expect(u1.next.intervalDays).toBe(u2.next.intervalDays);
  });

  it('replays under FSRS with calibration gaps', () => {
    setSrsScheduler('fsrs');
    const r = replaySrsReviews([
      { score: 'understood', reviewedAt: new Date('2026-05-01T00:00:00Z') },
      { score: 'understood', reviewedAt: new Date('2026-05-05T00:00:00Z') },
      { score: 'recognizes', reviewedAt: new Date('2026-05-20T00:00:00Z'), calibrationGap: 0.6 },
    ]);
    expect(r.state.stability).not.toBeNull();
    expect(r.lastGrade).toBe('recognizes');
  });
});

describe('orderBlockedLast', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const it_ = (id: string, due_at: string | null, blocked: boolean) => ({ id, due_at, blocked_prerequisites: blocked ? ['X'] : [] });
  it('sinks blocked items within their urgency bucket only', () => {
    const out = orderBlockedLast([
      it_('new-blocked', null, true),
      it_('new-free', null, false),
      it_('due-blocked', '2026-05-30T00:00:00Z', true),
      it_('due-free', '2026-05-31T00:00:00Z', false),
      it_('later-free', '2026-06-09T00:00:00Z', false),
    ], now);
    expect(out.map(x => x.id)).toEqual(['new-free', 'new-blocked', 'due-free', 'due-blocked', 'later-free']);
  });
});
