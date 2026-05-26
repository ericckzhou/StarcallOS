import { describe, it, expect } from 'vitest';
import { findDefinitions, findRelations, findMisconceptionPhrases, findCapitalizedPhrases } from './grammar';
import { extractCandidates } from './candidates';
import type { SegmentedBlock } from './layout';

// ─── Grammar primitives ──────────────────────────────────────────────────────

describe('findDefinitions', () => {
  it('catches "X is defined as Y"', () => {
    const hits = findDefinitions('A tensor is defined as a multi-dimensional array of numbers.');
    expect(hits.map(h => h.term)).toContain('A tensor');
    expect(hits[0].pattern).toBe('is_defined_as');
  });

  it('catches "X refers to Y"', () => {
    const hits = findDefinitions('Backpropagation refers to the algorithm used to train neural networks.');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].pattern).toBe('refers_to');
  });

  it('catches "X is a type of Y"', () => {
    const hits = findDefinitions('A convolutional layer is a type of layer used in image processing.');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].pattern).toBe('is_a');
  });

  it('catches colon-style defs at line start', () => {
    const hits = findDefinitions('Gradient Descent: An iterative optimization method that follows the negative gradient of a loss function.');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].pattern).toBe('colon_def');
  });
});

describe('findRelations', () => {
  it('catches "X requires Y"', () => {
    const hits = findRelations('Backpropagation requires differentiable activation functions.');
    expect(hits[0]?.kind).toBe('requires');
  });

  it('catches "X causes Y"', () => {
    const hits = findRelations('Vanishing gradients causes slow convergence in deep networks.');
    expect(hits[0]?.kind).toBe('causes');
  });
});

describe('findMisconceptionPhrases', () => {
  it('catches "Common mistake:"', () => {
    const hits = findMisconceptionPhrases('Common mistake: students often think that dropout is applied at inference time.');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('catches "Do not confuse X with Y"', () => {
    const hits = findMisconceptionPhrases('Do not confuse cross-entropy with mean squared error.');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('findCapitalizedPhrases', () => {
  it('finds multi-word capitalized terms', () => {
    const phrases = findCapitalizedPhrases('Long Short-Term Memory networks were introduced by Hochreiter.');
    expect(phrases.some(p => p.includes('Long Short'))).toBe(true);
  });

  it('filters pure stopword sequences', () => {
    const phrases = findCapitalizedPhrases('The The The is a stopword sentence.');
    expect(phrases).not.toContain('The');
  });
});

// ─── Candidate extractor end-to-end ──────────────────────────────────────────

function block(partial: Partial<SegmentedBlock> & { text: string; page: number; readingOrder: number }): SegmentedBlock {
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

describe('extractCandidates', () => {
  it('promotes headings to high-confidence candidates', () => {
    const blocks = [
      block({ text: 'Backpropagation', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'This section explains how backpropagation works in neural networks.', page: 1, readingOrder: 1 }),
    ];
    const result = extractCandidates(blocks, new Map([[0, []], [1, ['Backpropagation']]]));
    const backprop = result.candidates.find(c => c.normalized === 'backpropagation');
    expect(backprop).toBeDefined();
    expect(backprop!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(backprop!.evidence.some(e => e.source === 'heading')).toBe(true);
  });

  it('stacks confidence across multiple signals', () => {
    const blocks = [
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'Gradient Descent is defined as an iterative optimization method.', page: 1, readingOrder: 1 }),
      block({ text: 'Gradient Descent works by following the negative gradient.', page: 2, readingOrder: 2 }),
      block({ text: 'Note that Gradient Descent requires a differentiable loss.', page: 2, readingOrder: 3 }),
      block({ text: 'In practice Gradient Descent is paired with momentum.', page: 3, readingOrder: 4 }),
    ];
    const result = extractCandidates(blocks, new Map());
    const gd = result.candidates.find(c => c.normalized === 'gradient descent');
    expect(gd).toBeDefined();
    // heading (.55) + definition (.40) — capped at 1
    expect(gd!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(gd!.evidence.length).toBeGreaterThan(1);
  });

  it('emits diagnostics', () => {
    const blocks = [
      block({ text: 'Chapter 1', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'A neuron is defined as a computational unit.', page: 1, readingOrder: 1 }),
    ];
    const result = extractCandidates(blocks, new Map());
    expect(result.diagnostics.blocks_seen).toBe(2);
    expect(result.diagnostics.headings_seen).toBe(1);
    expect(result.diagnostics.definitions_found).toBeGreaterThan(0);
  });

  it('adds typography labels and final score for true headings', () => {
    const blocks = [
      block({
        text: 'PROCESS SCHEDULING',
        page: 12,
        readingOrder: 0,
        hint: 'heading',
        hintConfidence: 2,
        signals: {
          fontSizeRatio: 1.5,
          yGapAbove: 20,
          yGapBelow: 18,
          xColumnIndex: 0,
          isIsolatedLine: true,
          isAllCaps: true,
          isBold: true,
          lineCount: 1,
        },
      }),
      block({ text: 'Process scheduling decides which runnable process gets CPU time.', page: 12, readingOrder: 1 }),
    ];

    const result = extractCandidates(blocks, new Map([[0, []], [1, ['PROCESS SCHEDULING']]]), ['process', 'cpu', 'scheduling']);
    const candidate = result.candidates.find(c => c.term === 'PROCESS SCHEDULING');

    expect(candidate).toBeDefined();
    expect(candidate!.final_score).toBeGreaterThanOrEqual(0.55);
    expect(candidate!.labels).toContain('section_heading');
    expect(candidate!.labels).toContain('large_font');
    expect(candidate!.context_snippet).toContain('CPU time');
    expect(result.diagnostics.typography_backed_candidates).toBeGreaterThan(0);
  });

  it('penalizes sentence fragments and caption-like headings', () => {
    const result = extractCandidates([
      block({ text: 'In this example, if CPU 0 references instructions or data', page: 4, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'Figure 2.1: State transitions', page: 5, readingOrder: 1, hint: 'heading', hintConfidence: 2 }),
    ], new Map());

    const fragment = result.candidates.find(c => c.term.startsWith('In this example'));
    const caption = result.candidates.find(c => c.term.startsWith('Figure'));

    expect(fragment?.labels).toContain('sentence_fragment');
    expect(fragment?.final_score).toBeLessThan(0.55);
    expect(caption?.labels).toContain('caption_or_figure');
    expect(caption?.final_score).toBeLessThan(0.55);
  });

  it('keeps definition-pattern evidence ahead of heading-only duplicates', () => {
    const result = extractCandidates([
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'Gradient Descent is defined as an iterative method for optimization.', page: 2, readingOrder: 1 }),
    ], new Map());

    const gd = result.candidates.find(c => c.normalized === 'gradient descent');

    expect(gd?.term).toBe('Gradient Descent');
    expect(gd?.labels).toContain('defined_term');
    expect(gd?.evidence[0].source === 'definition_pattern' || gd?.evidence.some(e => e.source === 'definition_pattern')).toBe(true);
  });

  it('captures relations independently of candidates', () => {
    const blocks = [
      block({ text: 'Backpropagation requires differentiable activation functions.', page: 1, readingOrder: 0 }),
    ];
    const result = extractCandidates(blocks, new Map());
    expect(result.relations.length).toBeGreaterThan(0);
    expect(result.relations[0].kind).toBe('requires');
  });
});
