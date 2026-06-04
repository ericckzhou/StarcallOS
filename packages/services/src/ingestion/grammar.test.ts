import { describe, expect, it } from 'vitest';
import {
  findDefinitions,
  findRelations,
  findMisconceptionPhrases,
  findCapitalizedPhrases,
} from './grammar';

describe('findDefinitions', () => {
  it('captures "X is defined as Y" with the term and pattern name', () => {
    const hits = findDefinitions(
      'Backpropagation is defined as the reverse-mode application of the chain rule.',
    );
    expect(hits.some(h => h.term === 'Backpropagation' && h.pattern === 'is_defined_as')).toBe(true);
  });

  it('captures "X refers to Y"', () => {
    const hits = findDefinitions('Overfitting refers to a model that memorizes noise.');
    expect(hits.some(h => h.term === 'Overfitting' && h.pattern === 'refers_to')).toBe(true);
  });

  it('captures a colon definition with a substantial body', () => {
    const hits = findDefinitions(
      'Gradient: A first-order iterative optimization algorithm for finding minima.',
    );
    expect(hits.some(h => h.term === 'Gradient' && h.pattern === 'colon_def')).toBe(true);
  });

  it('does not treat a short colon line as a definition', () => {
    const hits = findDefinitions('Note: short.');
    expect(hits.some(h => h.pattern === 'colon_def')).toBe(false);
  });

  it('returns nothing for plain prose', () => {
    expect(findDefinitions('The cat sat quietly on the warm windowsill.')).toEqual([]);
  });

  it('preserves the full sentence as the quote', () => {
    const hits = findDefinitions('Backpropagation is defined as the chain rule applied backward.');
    const hit = hits.find(h => h.pattern === 'is_defined_as');
    expect(hit?.quote).toBe('Backpropagation is defined as the chain rule applied backward.');
  });
});

describe('findRelations', () => {
  it('captures a requires relation', () => {
    const hits = findRelations('Backpropagation requires differentiable activation functions.');
    expect(hits.some(h => h.from === 'Backpropagation' && h.kind === 'requires')).toBe(true);
  });

  it('captures a causes relation', () => {
    const hits = findRelations('Overfitting causes poor generalization on held-out data.');
    const hit = hits.find(h => h.kind === 'causes');
    expect(hit?.from).toBe('Overfitting');
    expect(hit?.to).toContain('poor');
  });

  it('captures a contrasts_with relation (case-insensitive)', () => {
    const hits = findRelations('Unlike Bagging, boosting trains learners sequentially.');
    expect(hits.some(h => h.from === 'Bagging' && h.kind === 'contrasts_with')).toBe(true);
  });

  it('captures an example_of relation', () => {
    const hits = findRelations('Adam is an example of gradient descent optimization here.');
    expect(hits.some(h => h.from === 'Adam' && h.kind === 'example_of')).toBe(true);
  });

  it('returns nothing when no relation pattern is present', () => {
    expect(findRelations('The weather was pleasant throughout the afternoon.')).toEqual([]);
  });
});

describe('findMisconceptionPhrases', () => {
  it('captures an explicit common-misconception phrase', () => {
    const phrases = findMisconceptionPhrases(
      'A common misconception: students think dropout slows training permanently.',
    );
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/common misconception/i);
  });

  it('captures a "do not confuse" warning', () => {
    const phrases = findMisconceptionPhrases('Do not confuse precision with recall in this context.');
    expect(phrases.some(p => /do not confuse/i.test(p))).toBe(true);
  });

  it('returns an empty array for prose without misconception cues', () => {
    expect(findMisconceptionPhrases('We then trained the model for ten epochs.')).toEqual([]);
  });
});

describe('findCapitalizedPhrases', () => {
  it('captures multi-word capitalized technical terms', () => {
    const phrases = findCapitalizedPhrases(
      'We study Gradient Descent and Stochastic Gradient Descent today.',
    );
    expect(phrases).toContain('Gradient Descent');
    expect(phrases).toContain('Stochastic Gradient Descent');
  });

  it('drops single stopwords like "We"', () => {
    const phrases = findCapitalizedPhrases('We study Gradient Descent today.');
    expect(phrases).not.toContain('We');
  });

  it('drops phrases made entirely of stopwords', () => {
    expect(findCapitalizedPhrases('The Figure shows nothing notable.')).toEqual([]);
  });

  it('deduplicates repeated phrases', () => {
    const phrases = findCapitalizedPhrases('Gradient Descent improves. Gradient Descent converges.');
    expect(phrases.filter(p => p === 'Gradient Descent')).toHaveLength(1);
  });
});
