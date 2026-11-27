import { describe, expect, it } from 'vitest';
import { ocrParagraphsToSource, ocrTextToSource, type OcrParagraph } from './ocr_text';

const para = (...lines: Array<[string, number]>): OcrParagraph => ({ lines: lines.map(([text, height]) => ({ text, height })) });

describe('ocrParagraphsToSource', () => {
  it('splits a taller heading line off its paragraph as a markdown heading', () => {
    const out = ocrParagraphsToSource([
      para(['Gradient Descent', 34], ['Gradient descent is an', 20], ['iterative method.', 20]),
      para(['The learning rate sets the', 21], ['step size.', 20]),
    ]);
    expect(out).toBe('# Gradient Descent\n\nGradient descent is an iterative method.\n\nThe learning rate sets the step size.');
  });

  it('joins a two-line heading and leaves uniform-height text alone', () => {
    // Detection is relative to the median line, so body text must dominate (as
    // on any real page); a page that is mostly tall text has no "headings".
    expect(ocrParagraphsToSource([para(['Chapter 3:', 40], ['Optimization', 40], ['Body text', 20], ['goes on', 20], ['for a while.', 20])]))
      .toBe('# Chapter 3: Optimization\n\nBody text goes on for a while.');
    expect(ocrParagraphsToSource([para(['All the same', 20], ['height lines.', 20])])).toBe('All the same height lines.');
  });

  it('does not treat a long tall line as a heading, and drops noise paragraphs', () => {
    const long = 'x'.repeat(90);
    expect(ocrParagraphsToSource([para([long, 40], ['short', 20], ['short', 20]), para(['—', 20])])).toBe(`${long} short short`);
    expect(ocrParagraphsToSource([])).toBe('');
  });
});

describe('ocrTextToSource', () => {
  it('unwraps lines inside a paragraph and keeps paragraph breaks', () => {
    const raw = 'Gradient descent is an\niterative method.\n\nIt uses the\ngradient.';
    expect(ocrTextToSource(raw)).toBe('Gradient descent is an iterative method.\n\nIt uses the gradient.');
  });

  it('rejoins words hyphenated across a line break, but keeps real hyphens', () => {
    expect(ocrTextToSource('an opti-\nmization method')).toBe('an optimization method');
    expect(ocrTextToSource('a state-of-the-\nArt result')).toBe('a state-of-the- Art result');
    expect(ocrTextToSource('well-known\nresult')).toBe('well-known result');
  });

  it('drops pure-noise lines and empty paragraphs', () => {
    const raw = '—— • ——\n\nReal text here\n|||\nmore text\n\n...\n';
    expect(ocrTextToSource(raw)).toBe('Real text here more text');
  });

  it('keeps headings and list items on their own lines', () => {
    const raw = '# Chapter 1\nIntro line\n- first item\n- second\nwraps on';
    expect(ocrTextToSource(raw)).toBe('# Chapter 1 Intro line\n- first item\n- second wraps on');
  });

  it('normalizes CRLF and runs of spaces; empty input stays empty', () => {
    expect(ocrTextToSource('a   b\r\nc\r\n\r\nd')).toBe('a b c\n\nd');
    expect(ocrTextToSource('  \n \n')).toBe('');
  });
});
