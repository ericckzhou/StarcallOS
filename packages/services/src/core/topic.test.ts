import { describe, expect, it } from 'vitest';
import {
  isBoilerplateHeading,
  deriveTopicAnchors,
  scoreTopicRelevance,
  tokenize,
} from './topic';
import type { SegmentedBlock } from '../ingestion/layout';

function block(
  partial: Partial<SegmentedBlock> & { text: string; page: number; readingOrder: number },
): SegmentedBlock {
  return {
    text: partial.text,
    page: partial.page,
    readingOrder: partial.readingOrder,
    hint: partial.hint ?? 'body',
    hintConfidence: partial.hintConfidence ?? 2,
    signals: partial.signals ?? {
      fontSizeRatio: 1.0,
      yGapAbove: 0,
      xColumnIndex: 0,
      isIsolatedLine: false,
      isAllCaps: false,
      isBold: false,
    },
  };
}

describe('isBoilerplateHeading', () => {
  it('matches known boilerplate section names', () => {
    expect(isBoilerplateHeading('references')).toBe(true);
    expect(isBoilerplateHeading('table of contents')).toBe(true);
    expect(isBoilerplateHeading('acknowledgements')).toBe(true);
  });

  it('rejects substantive headings', () => {
    expect(isBoilerplateHeading('gradient descent')).toBe(false);
  });

  it('is exact and case-sensitive on the normalized input', () => {
    expect(isBoilerplateHeading('References')).toBe(false);
  });
});

describe('tokenize', () => {
  it('lowercases, drops stopwords, and keeps tokens of length >= 3', () => {
    expect(tokenize('The Gradient Descent Algorithm')).toEqual(['gradient', 'descent', 'algorithm']);
  });

  it('returns an empty array when everything is a stopword or too short', () => {
    expect(tokenize('a is on the')).toEqual([]);
  });
});

describe('deriveTopicAnchors', () => {
  it('weights the title above heading tokens', () => {
    const blocks = [
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
    ];

    const anchors = deriveTopicAnchors(blocks, 'Deep Learning');

    expect(anchors).toContain('deep');
    expect(anchors).toContain('gradient');
    // Title tokens carry weight 3 vs heading weight 1, so they rank first.
    expect(anchors.indexOf('deep')).toBeLessThan(anchors.indexOf('gradient'));
  });

  it('ignores body blocks when collecting heading tokens', () => {
    const blocks = [
      block({ text: 'neural networks everywhere', page: 1, readingOrder: 0, hint: 'body', hintConfidence: 2 }),
    ];

    expect(deriveTopicAnchors(blocks, null)).not.toContain('neural');
  });

  it('respects the maxAnchors cap', () => {
    const blocks = [
      block({ text: 'Optimization Methods Overview', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
    ];

    expect(deriveTopicAnchors(blocks, 'Deep Learning Systems', 1)).toHaveLength(1);
  });
});

describe('scoreTopicRelevance', () => {
  it('returns 1.0 with no reasons when there are no anchors', () => {
    expect(scoreTopicRelevance(['x'], ['y'], [])).toEqual({ score: 1.0, reasons: [] });
  });

  it('scores a fully on-topic candidate at 1 with a term reason', () => {
    const result = scoreTopicRelevance(['gradient', 'descent'], [], ['gradient', 'descent']);
    expect(result.score).toBe(1);
    expect(result.reasons[0]).toMatch(/^term:/);
  });

  it('scores an off-topic candidate at 0 with no reasons', () => {
    const result = scoreTopicRelevance(['cooking', 'recipe'], ['kitchen'], ['gradient', 'descent']);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('weights term matches above evidence-only matches', () => {
    const termMatch = scoreTopicRelevance(['gradient'], [], ['gradient']);
    const evidenceMatch = scoreTopicRelevance(['unrelated'], ['gradient'], ['gradient']);

    expect(evidenceMatch.score).toBeLessThan(termMatch.score);
    expect(evidenceMatch.reasons.some(r => r.startsWith('evidence:'))).toBe(true);
  });
});
