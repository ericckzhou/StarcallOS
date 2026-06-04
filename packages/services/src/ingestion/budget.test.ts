import { describe, expect, it } from 'vitest';
import { selectBudgetedBlocks, DEFAULT_BUDGET } from './budget';
import type { SegmentedBlock } from './layout';
import type { ConceptCandidate } from './candidates';

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

function candidate(pages: number[]): ConceptCandidate {
  return {
    term: 'X',
    normalized: 'x',
    confidence: 0.9,
    evidence: pages.map(p => ({ source: 'heading' as const, quote: 'q', page: p })),
    section_path: [],
    first_page: pages[0] ?? 1,
    mention_count: pages.length,
    topic_relevance_score: 1,
    topic_relevance_reasons: [],
    is_boilerplate: false,
    is_broad: false,
    concept_score: 0.9,
    reject_reasons: [],
  };
}

describe('selectBudgetedBlocks', () => {
  it('falls back to all blocks when there are no candidates', () => {
    const blocks = [block({ text: 'a', page: 1, readingOrder: 0 })];

    const result = selectBudgetedBlocks(blocks, []);

    expect(result.blocks).toBe(blocks);
    expect(result.diagnostics.fallbackToFull).toBe(true);
    expect(result.diagnostics.candidatesUsed).toBe(0);
  });

  it('falls back to all blocks when there are no blocks', () => {
    const result = selectBudgetedBlocks([], [candidate([5])]);

    expect(result.blocks).toEqual([]);
    expect(result.diagnostics.fallbackToFull).toBe(true);
  });

  it('keeps blocks within the evidence page window and always keeps headings', () => {
    const blocks = [
      block({ text: 'p4', page: 4, readingOrder: 0 }),
      block({ text: 'p5', page: 5, readingOrder: 1 }),
      block({ text: 'p6', page: 6, readingOrder: 2 }),
      block({ text: 'far body', page: 10, readingOrder: 3 }),
      block({ text: 'far heading', page: 10, readingOrder: 4, hint: 'heading' }),
    ];

    const result = selectBudgetedBlocks(blocks, [candidate([5])], { minBlocks: 2, pageWindow: 1 });

    expect(result.diagnostics.fallbackToFull).toBe(false);
    const kept = result.blocks.map(b => b.text);
    expect(kept).toEqual(['p4', 'p5', 'p6', 'far heading']);
    expect(kept).not.toContain('far body');
    expect(result.diagnostics.pagesKept).toBe(3); // {4,5,6}
    expect(result.diagnostics.candidatesUsed).toBe(1);
  });

  it('honors a pageWindow of 0 (only the exact evidence page)', () => {
    const blocks = [
      block({ text: 'p4', page: 4, readingOrder: 0 }),
      block({ text: 'p5', page: 5, readingOrder: 1 }),
      block({ text: 'p6', page: 6, readingOrder: 2 }),
    ];

    const result = selectBudgetedBlocks(blocks, [candidate([5])], { minBlocks: 1, pageWindow: 0 });

    expect(result.blocks.map(b => b.text)).toEqual(['p5']);
  });

  it('falls back to full when the gated set is below minBlocks', () => {
    const blocks = [
      block({ text: 'p5', page: 5, readingOrder: 0 }),
      block({ text: 'far', page: 99, readingOrder: 1 }),
    ];

    const result = selectBudgetedBlocks(blocks, [candidate([5])], { minBlocks: 10, pageWindow: 0 });

    expect(result.blocks).toBe(blocks);
    expect(result.diagnostics.fallbackToFull).toBe(true);
    expect(result.diagnostics.selectedBlocks).toBe(2);
  });

  it('only seeds pages from the top-N candidates', () => {
    const blocks = [
      block({ text: 'p5', page: 5, readingOrder: 0 }),
      block({ text: 'p9', page: 9, readingOrder: 1 }),
    ];
    const candidates = [candidate([5]), candidate([9])];

    const result = selectBudgetedBlocks(blocks, candidates, { topN: 1, minBlocks: 1, pageWindow: 0 });

    expect(result.blocks.map(b => b.text)).toEqual(['p5']);
    expect(result.diagnostics.candidatesUsed).toBe(1);
  });

  it('exposes sane default budget constants', () => {
    expect(DEFAULT_BUDGET).toEqual({ topN: 50, pageWindow: 1, minBlocks: 12 });
  });
});
