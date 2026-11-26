// FSRS-5 scheduler (Free Spaced Repetition Scheduler), pure TS, default
// published parameters. Models each card by stability S (days until recall
// probability falls to 90%) and difficulty D (1..10). Reference:
// https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
//
// Rating mapping from StarcallOS grades (see evidenceScoreToFsrsRating):
//   understood → Good (3), recognizes → Hard (2), gap/misconception → Again (1).
// "Easy" is never produced: an excellent answer still schedules as Good, which
// keeps intervals conservative for open-ended answers.

import type { EvidenceScore } from '../core/domain/types';

export type FsrsRating = 1 | 2 | 3 | 4;

export const FSRS5_DEFAULT_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81; // makes R(S, S) = 0.9
export const FSRS_TARGET_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 36_500;

export interface FsrsCard {
  stability: number;
  difficulty: number;
}

export function evidenceScoreToFsrsRating(score: EvidenceScore): FsrsRating {
  switch (score) {
    case 'understood': return 3;
    case 'recognizes': return 2;
    case 'gap': return 1;
    case 'misconception': return 1;
  }
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));

export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
}

function initialStability(g: FsrsRating, w: readonly number[]): number {
  return Math.max(0.1, w[g - 1]);
}

function initialDifficulty(g: FsrsRating, w: readonly number[]): number {
  return clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1);
}

function nextDifficulty(d: number, g: FsrsRating, w: readonly number[]): number {
  const delta = -w[6] * (g - 3);
  const damped = d + delta * (10 - d) / 9;               // linear damping
  return clampD(w[7] * initialDifficulty(4, w) + (1 - w[7]) * damped); // mean reversion
}

function recallStability(d: number, s: number, r: number, g: FsrsRating, w: readonly number[]): number {
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy + 1);
}

function forgetStability(d: number, s: number, r: number, w: readonly number[]): number {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  return Math.min(sf, s);
}

function shortTermStability(s: number, g: FsrsRating, w: readonly number[]): number {
  return s * Math.exp(w[17] * (g - 3 + w[18]));
}

// Days until recall probability drops to the target retention.
export function fsrsInterval(stability: number, retention = FSRS_TARGET_RETENTION): number {
  const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days)));
}

// Advance a card by one review. `card` null = first review. `elapsedDays` is
// time since the previous review (ignored on the first).
export function fsrsNext(
  card: FsrsCard | null,
  g: FsrsRating,
  elapsedDays: number,
  w: readonly number[] = FSRS5_DEFAULT_WEIGHTS,
): FsrsCard & { intervalDays: number } {
  let stability: number;
  let difficulty: number;
  if (!card) {
    stability = initialStability(g, w);
    difficulty = initialDifficulty(g, w);
  } else if (elapsedDays < 1) {
    // Same-day re-review: short-term stability update.
    stability = shortTermStability(card.stability, g, w);
    difficulty = nextDifficulty(card.difficulty, g, w);
  } else {
    const r = retrievability(elapsedDays, card.stability);
    difficulty = nextDifficulty(card.difficulty, g, w);
    stability = g === 1
      ? forgetStability(card.difficulty, card.stability, r, w)
      : recallStability(card.difficulty, card.stability, r, g, w);
  }
  stability = Math.max(0.1, stability);
  return { stability, difficulty, intervalDays: g === 1 ? 1 : fsrsInterval(stability) };
}
