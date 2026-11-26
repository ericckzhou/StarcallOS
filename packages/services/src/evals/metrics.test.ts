import { describe, expect, it } from 'vitest';
import {
  addressesGap, compareToBaseline, jaccard, precisionAtK, recallAtK, reciprocalRank,
  percentile, scoreAsk, scoreGrader, scoreRetrieval, scoreTasks, scoreTopicFilter, type AskCaseResult,
} from './metrics';

describe('scoreGrader', () => {
  it('computes accuracy, stage tolerance, confusion and unsupported P/R', () => {
    const m = scoreGrader([
      { id: 'a', expected: { score: 'understood', stage: 3, expects_unsupported: false }, actual: { score: 'understood', stage: 3, unsupported_count: 0 } },
      { id: 'b', expected: { score: 'recognizes', stage: 2, expects_unsupported: true }, actual: { score: 'understood', stage: 3, unsupported_count: 1 } },
      { id: 'c', expected: { score: 'misconception', stage: 1, expects_unsupported: true }, actual: { score: 'gap', stage: 0, unsupported_count: 0 } },
      { id: 'd', expected: { score: 'gap', stage: 1 }, actual: null },
    ]);
    expect(m.n).toBe(4);
    expect(m.failed).toBe(1);
    expect(m.score_accuracy).toBeCloseTo(1 / 3);
    expect(m.stage_exact).toBeCloseTo(1 / 3);
    expect(m.stage_within_1).toBe(1);
    expect(m.stage_mae).toBeCloseTo(2 / 3);
    expect(m.confusion.recognizes.understood).toBe(1);
    expect(m.confusion.misconception.gap).toBe(1);
    expect(m.unsupported).toMatchObject({ tp: 1, fn: 1, tn: 1, fp: 0, precision: 1, recall: 0.5 });
  });
});

describe('scoreTasks', () => {
  it('flags near-duplicates and kind coverage', () => {
    expect(jaccard('Explain eigenvalues of a matrix', 'Explain the eigenvalues of a matrix')).toBeGreaterThan(0.7);
    const m = scoreTasks([
      {
        id: 'x', expected_kinds: ['definition', 'application'], tasks: [
          { kind: 'definition', prompt: 'Explain eigenvalues of a matrix' },
          { kind: 'application', prompt: 'Explain the eigenvalues of a matrix' },
          { kind: 'compression', prompt: 'Summarize spectral decomposition in one sentence' },
        ],
      },
      { id: 'y', tasks: null },
    ]);
    expect(m.failed).toBe(1);
    expect(m.mean_tasks).toBe(3);
    expect(m.near_duplicate_rate).toBeCloseTo(1 / 3);
    expect(m.kind_coverage).toBe(1);
  });
});

describe('scoreTopicFilter', () => {
  it('scores keep decisions case-insensitively', () => {
    const m = scoreTopicFilter([
      { id: 's', labels: { Eigenvalue: true, Figure: false, Basis: true, Chapter: false }, kept: ['eigenvalue', 'chapter'] },
    ]);
    expect(m.keep).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1 });
    expect(m.f1).toBeCloseTo(0.5);
    expect(m.accuracy).toBe(0.5);
  });
});

describe('compareToBaseline', () => {
  it('reports drops beyond tolerance, respecting lower-is-better metrics', () => {
    const r = compareToBaseline(
      { score_accuracy: 0.70, stage_mae: 0.9, stage_within_1: 0.89 },
      { score_accuracy: 0.80, stage_mae: 0.5, stage_within_1: 0.90 },
    );
    expect(r.map(x => x.metric).sort()).toEqual(['score_accuracy', 'stage_mae']);
  });
});

describe('gap targeting proxy', () => {
  it('matches prompts sharing content words with a seeded gap', () => {
    expect(addressesGap('How do hot keys break load balance on a consistent hashing ring?', 'Did not mention hot-key skew breaking load balance')).toBe(true);
    expect(addressesGap('Define consistent hashing.', 'Did not mention hot-key skew breaking load balance')).toBe(false);
    const m = scoreTasks([
      { id: 'a', history_gaps: ['ignores replication factor tradeoffs'], tasks: [{ kind: 'application', prompt: 'Pick a replication factor and explain the tradeoffs.' }] },
      { id: 'b', history_gaps: ['ignores replication factor tradeoffs'], tasks: [{ kind: 'definition', prompt: 'Define a ring.' }] },
      { id: 'c', tasks: [{ kind: 'definition', prompt: 'Define a ring.' }] },
    ]);
    expect(m.gap_targeting).toBe(0.5);
    expect(scoreTasks([{ id: 'c', tasks: [] }]).gap_targeting).toBeNull();
  });
});

describe('retrieval metrics', () => {
  const rel = new Set(['a', 'b']);
  it('computes precision@k, recall@k and reciprocal rank', () => {
    expect(precisionAtK(rel, ['x', 'a', 'y', 'b'], 2)).toBe(0.5);
    expect(precisionAtK(rel, ['a'], 4)).toBe(0.25);          // short lists still divide by k
    expect(recallAtK(rel, ['x', 'a', 'y', 'b'], 2)).toBe(0.5);
    expect(recallAtK(rel, ['a', 'a', 'b'], 3)).toBe(1);      // duplicates do not double count
    expect(recallAtK(new Set(), ['a'], 3)).toBe(0);
    expect(reciprocalRank(rel, ['x', 'y', 'b'])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(rel, ['x', 'y', 'b'], 2)).toBe(0);
    expect(reciprocalRank(rel, [])).toBe(0);
  });

  it('aggregates answerable cases, splits categories and keeps unanswerable apart', () => {
    const m = scoreRetrieval([
      { id: '1', category: 'exact_term', answerable: true, relevant: ['a'], retrieved: ['a', 'x'], top_score: 0.9 },
      { id: '2', category: 'conceptual', answerable: true, relevant: ['b', 'c'], retrieved: ['x', 'c'], top_score: 0.7 },
      { id: '3', category: 'no_answer', answerable: false, relevant: [], retrieved: ['z'], top_score: 0.4 },
    ], 2);
    expect(m).toMatchObject({ k: 2, n: 2, n_unanswerable: 1, coverage: 1, mrr: 0.75, recall_at_k: 0.75, precision_at_k: 0.5 });
    expect(m.by_category.conceptual).toMatchObject({ n: 1, mrr: 0.5, recall_at_k: 0.5 });
    expect(m.by_category.no_answer).toBeUndefined();
    expect(m.mean_top_score_answerable).toBe(0.8);
    expect(m.mean_top_score_unanswerable).toBe(0.4);
  });
});

describe('ask metrics', () => {
  const c = (o: Partial<AskCaseResult>): AskCaseResult => ({
    id: 'x', category: 'exact_term', answerable: true, relevant: ['a'], status: 'grounded', cited: [], dropped: 0, latency_ms: 100, ...o,
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('scores statuses, citations, abstention and drops', () => {
    const m = scoreAsk([
      c({ id: '1', status: 'grounded', cited: ['a', 'b'], latency_ms: 100 }),
      c({ id: '2', status: 'partial', cited: ['z'], dropped: 1, latency_ms: 300 }),
      c({ id: '3', status: 'insufficient', latency_ms: 200 }),
      c({ id: '4', status: 'retrieval_only', latency_ms: 50 }),
      c({ id: '4b', status: 'qualified', cited: ['a'], latency_ms: 60 }),
      c({ id: '5', category: 'no_answer', answerable: false, relevant: [], status: 'insufficient', latency_ms: 80 }),
      c({ id: '6', category: 'no_answer', answerable: false, relevant: [], status: 'grounded', cited: ['q'], latency_ms: 90 }),
    ]);
    expect(m.n).toBe(7);
    expect(m.answerable).toEqual({
      n: 5, grounded_rate: 0.2, supported_rate: 0.6, declined_rate: 0.2, unsupported_rate: 0, failed_rate: 0.2,
    });
    expect(m.correct_abstention_rate).toBe(0.5);
    expect(m.n_unanswerable).toBe(2);
    // answerable citations: a (rel), b, z, a (rel) → 2/4
    expect(m.citation_precision).toBe(0.5);
    // supported answerable (qualified counts): #1 and #4b cite a relevant chunk, #2 does not
    expect(m.relevant_citation_rate).toBe(0.667);
    // verified 5 (a,b,z,a,q) + dropped 1
    expect(m.dropped_citation_rate).toBe(0.167);
    expect(m.latency_p50_ms).toBe(90);
    expect(m.by_category.no_answer.n).toBe(2);
  });

  it('reports null rates when there is nothing to measure', () => {
    const m = scoreAsk([c({ status: 'insufficient' })]);
    expect(m.correct_abstention_rate).toBeNull();
    expect(m.citation_precision).toBeNull();
    expect(m.relevant_citation_rate).toBeNull();
    expect(m.dropped_citation_rate).toBeNull();
  });
});
