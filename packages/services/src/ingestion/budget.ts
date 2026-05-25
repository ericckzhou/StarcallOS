// Candidate-gated extraction budget.
// Picks the subset of geometry blocks worth sending to the LLM enricher.
// The deterministic candidate parser has already told us *what* is interesting;
// this module decides *which blocks* to actually pay for.
//
// Strategy:
//   1. Always keep headings + subheadings — they're cheap and anchor structure.
//   2. Take the top-N concept candidates by confidence.
//   3. Collect every page mentioned in their evidence (+/- pageWindow).
//   4. Keep any block whose page falls in that union.
//   5. If the result is unhealthily small (fewer than minBlocks), fall back to
//      everything — better to spend tokens than ship an empty extraction.

import type { SegmentedBlock } from './layout';
import type { ConceptCandidate } from './candidates';

export interface BudgetOptions {
  topN: number;          // how many candidates seed the page set
  pageWindow: number;    // ± pages around each evidence page
  minBlocks: number;     // floor; below this we abandon gating
}

export const DEFAULT_BUDGET: BudgetOptions = {
  topN: 50,
  pageWindow: 1,
  minBlocks: 12,
};

export interface BudgetResult {
  blocks: SegmentedBlock[];
  diagnostics: {
    inputBlocks: number;
    selectedBlocks: number;
    pagesKept: number;
    candidatesUsed: number;
    fallbackToFull: boolean;
  };
}

export function selectBudgetedBlocks(
  blocks: SegmentedBlock[],
  candidates: ConceptCandidate[],
  opts: Partial<BudgetOptions> = {},
): BudgetResult {
  const o = { ...DEFAULT_BUDGET, ...opts };

  if (blocks.length === 0 || candidates.length === 0) {
    return {
      blocks,
      diagnostics: {
        inputBlocks: blocks.length,
        selectedBlocks: blocks.length,
        pagesKept: new Set(blocks.map(b => b.page)).size,
        candidatesUsed: 0,
        fallbackToFull: true,
      },
    };
  }

  const top = candidates.slice(0, o.topN);
  const pages = new Set<number>();
  for (const c of top) {
    for (const e of c.evidence) {
      for (let dp = -o.pageWindow; dp <= o.pageWindow; dp++) {
        pages.add(e.page + dp);
      }
    }
  }

  const selected = blocks.filter(b =>
    pages.has(b.page) ||
    b.hint === 'heading' ||
    b.hint === 'subheading',
  );

  if (selected.length < o.minBlocks) {
    return {
      blocks,
      diagnostics: {
        inputBlocks: blocks.length,
        selectedBlocks: blocks.length,
        pagesKept: new Set(blocks.map(b => b.page)).size,
        candidatesUsed: top.length,
        fallbackToFull: true,
      },
    };
  }

  return {
    blocks: selected,
    diagnostics: {
      inputBlocks: blocks.length,
      selectedBlocks: selected.length,
      pagesKept: pages.size,
      candidatesUsed: top.length,
      fallbackToFull: false,
    },
  };
}
