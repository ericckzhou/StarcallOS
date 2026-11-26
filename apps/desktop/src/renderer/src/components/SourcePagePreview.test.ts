import { describe, expect, it, vi } from 'vitest';

// The module configures the pdfjs worker at import; tests only need the pure matcher.
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}));
vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: '' }));

import { spansForQuote } from './SourcePagePreview';

describe('spansForQuote', () => {
  // Text-layer spans as pdf.js emits them for b36 p. 200 (one span per line).
  const spans = [
    '7.2 Regular expressions',
    'Regular expressions contain three operators: alternation +, informally meaning “or”; con-',
    'catenation, informally meaning “followed by”; and repetition ∗, informally meaning “zero or',
    'more repetitions of”. As usual, parentheses are used to indicate the order.',
  ];

  it('covers every line of a quote that crosses a line-break hyphen, curly quotes and ∗', () => {
    expect(spansForQuote(spans, "alternation +, informally meaning 'or'; concatenation, informally meaning 'followed by'; and repetition *"))
      .toEqual([1, 2]);
  });

  it('matches a single-line quote to its span only', () => {
    expect(spansForQuote(spans, 'parentheses are used to indicate the order')).toEqual([3]);
  });

  it('folds the TeX epsilon glyph', () => {
    expect(spansForQuote(['Basis: ǫ ∈ L⊛. Induction Step'], 'Basis: ε ∈ L⊛. Induction')).toEqual([0]);
  });

  it('ignores math glyphs that pdf.js emits as out-of-order spans (real b36 p. 200)', () => {
    const live = [
      'Regular expressions contain three operators: alternation +, informally meaning “or”; con-',
      'catenation, informally meaning “followed by”; and repetition',
      ', informally meaning “zero or',
      'more repetitions of”. As usual, parentheses are used.',
      '∗',                                     // the glyph, emitted later in the stream
    ];
    expect(spansForQuote(live, "alternation +, informally meaning 'or'; concatenation, informally meaning 'followed by'; and repetition *, informally meaning 'zero or more repetitions of'"))
      .toEqual([0, 1, 2, 3]);
  });

  it('refuses quotes too short to locate reliably', () => {
    expect(spansForQuote(spans, '(0 + 1)')).toEqual([]);
  });

  it('returns nothing when the quote is not on the page', () => {
    expect(spansForQuote(spans, 'invented by Euclid')).toEqual([]);
  });

  it('spans elided quotes from the first piece to the last', () => {
    expect(spansForQuote(spans, 'Regular expressions contain … repetitions of')).toEqual([1, 2, 3]);
  });
});
