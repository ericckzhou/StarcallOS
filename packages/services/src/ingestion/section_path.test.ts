import { describe, expect, it } from 'vitest';
import { buildSectionPath } from './enrichment';
import type { SegmentedBlock, BlockHint } from './layout';

function block(
  readingOrder: number,
  page: number,
  text: string,
  hint: BlockHint,
  hintConfidence: 0 | 1 | 2,
  headingConfidence: number,
): SegmentedBlock {
  return {
    text,
    page,
    readingOrder,
    hint,
    hintConfidence,
    signals: {
      fontSizeRatio: hint === 'heading' ? 1.5 : 1,
      yGapAbove: 0,
      xColumnIndex: 0,
      isIsolatedLine: hint !== 'body',
      isAllCaps: false,
      isBold: hint === 'heading',
      headingConfidence,
    },
  };
}

describe('buildSectionPath provenance + gating', () => {
  it('tags blocks under an in-body heading as in_body_heading', () => {
    const blocks = [
      block(0, 1, 'Backpropagation', 'heading', 2, 0.9),
      block(1, 1, 'It propagates gradients backward.', 'body', 2, 0),
    ];
    const { paths, sources } = buildSectionPath(blocks, []);
    expect(paths.get(1)).toEqual(['Backpropagation']);
    expect(sources.get(1)).toBe('in_body_heading');
  });

  it('applies a running-header section only where there is no strong in-body heading', () => {
    const blocks = [
      block(0, 5, 'Body text on a page with no in-body heading.', 'body', 2, 0),
    ];
    const extra = [{ heading: 'Chapter 3 · Optimization', level: 1 as const, page_start: 4, page_end: 9 }];
    const { paths, sources } = buildSectionPath(blocks, extra);
    expect(paths.get(0)).toEqual(['Chapter 3 · Optimization']);
    expect(sources.get(0)).toBe('running_header');
  });

  it('does NOT overpower a strong in-body heading with a running header', () => {
    const blocks = [
      block(0, 5, 'Momentum', 'heading', 2, 0.9),
      block(1, 5, 'Momentum smooths the update direction.', 'body', 2, 0),
    ];
    const extra = [{ heading: 'Chapter 3', level: 1 as const, page_start: 1, page_end: 9 }];
    const { paths, sources } = buildSectionPath(blocks, extra);
    expect(paths.get(0)).toEqual(['Momentum']);
    expect(sources.get(0)).toBe('in_body_heading');
  });

  it('marks a weak in-body heading layered with a running header as mixed', () => {
    const blocks = [
      block(0, 5, 'Warm Restarts', 'subheading', 1, 0.3),
      block(1, 5, 'A scheduling trick.', 'body', 2, 0),
    ];
    const extra = [{ heading: 'Chapter 3', level: 1 as const, page_start: 1, page_end: 9 }];
    const { paths, sources } = buildSectionPath(blocks, extra);
    expect(paths.get(0)).toEqual(['Chapter 3', 'Warm Restarts']);
    expect(sources.get(0)).toBe('mixed');
  });
});
