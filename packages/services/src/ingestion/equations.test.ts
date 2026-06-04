import { describe, expect, it } from 'vitest';
import {
  looksLikeEquation,
  extractEquations,
  extractEquationsWithSections,
} from './equations';
import type { SegmentedBlock } from './layout';

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

describe('looksLikeEquation', () => {
  it('rejects empty and very short strings', () => {
    expect(looksLikeEquation('')).toBe(false);
    expect(looksLikeEquation('   ')).toBe(false);
    expect(looksLikeEquation('ab')).toBe(false);
  });

  it('rejects code-fence delimiters', () => {
    expect(looksLikeEquation('```')).toBe(false);
    expect(looksLikeEquation('```python')).toBe(false);
  });

  it('accepts display-math and leading-backslash LaTeX', () => {
    expect(looksLikeEquation('$$x = y$$')).toBe(true);
    expect(looksLikeEquation('\\frac{a}{b}')).toBe(true);
  });

  it('accepts text with two or more LaTeX commands', () => {
    expect(looksLikeEquation('the loss \\alpha plus \\beta term')).toBe(true);
  });

  it('accepts real inline math but rejects currency runs', () => {
    expect(looksLikeEquation('The value $x = y$ holds here')).toBe(true);
    expect(looksLikeEquation('We raised $320 million and $60 million in funding')).toBe(false);
  });

  it('accepts math-dense expressions with an equals sign', () => {
    expect(looksLikeEquation('a = b + c - d * e')).toBe(true);
  });

  it('accepts short Greek-dominated expressions', () => {
    expect(looksLikeEquation('θ < 1')).toBe(true);
  });

  it('rejects ordinary prose', () => {
    expect(looksLikeEquation('This is a normal sentence about cats.')).toBe(false);
  });
});

describe('extractEquations', () => {
  it('attaches an equation to the most recent heading and extracts variables', () => {
    const blocks = [
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({
        text: '\\theta = \\theta - \\alpha \\nabla L',
        page: 1,
        readingOrder: 1,
        hint: 'formula',
        hintConfidence: 1,
      }),
    ];

    const eqs = extractEquations(blocks);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].attached_term).toBe('gradient descent');
    expect(eqs[0].page).toBe(1);
    expect(eqs[0].reading_order).toBe(1);
    // \theta, \alpha, \nabla are layout/Greek commands and get filtered; L survives.
    expect(eqs[0].variables).toContain('L');
  });

  it('does not emit the heading block itself as an equation', () => {
    const blocks = [
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'a = b + c - d', page: 1, readingOrder: 1, hint: 'body', hintConfidence: 2 }),
    ];

    const eqs = extractEquations(blocks);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].latex).toBe('a = b + c - d');
  });

  it('strips list-item markers from the stored LaTeX', () => {
    const blocks = [
      block({ text: '* \\nabla L = 0', page: 2, readingOrder: 5, hint: 'formula', hintConfidence: 1 }),
    ];

    const eqs = extractEquations(blocks);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].latex).toBe('\\nabla L = 0');
  });

  it('captures equation-shaped lines mis-hinted as headings without clobbering the real heading', () => {
    const blocks = [
      block({ text: 'Energy Mass Equivalence', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'x = y + z - w', page: 1, readingOrder: 1, hint: 'heading', hintConfidence: 2 }),
    ];

    const eqs = extractEquations(blocks);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].latex).toBe('x = y + z - w');
    expect(eqs[0].attached_term).toBe('energy mass equivalence');
  });

  it('leaves attached_term null when no heading precedes the equation', () => {
    const blocks = [
      block({ text: 'a = b + c - d', page: 1, readingOrder: 0, hint: 'body', hintConfidence: 2 }),
    ];

    const eqs = extractEquations(blocks);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].attached_term).toBeNull();
  });

  it('ignores plain prose blocks', () => {
    const blocks = [
      block({ text: 'This paragraph explains the concept in words.', page: 1, readingOrder: 0 }),
    ];

    expect(extractEquations(blocks)).toHaveLength(0);
  });
});

describe('extractEquationsWithSections', () => {
  it('fills section_path from the sectionPaths map by reading order', () => {
    const blocks = [
      block({ text: 'Gradient Descent', page: 1, readingOrder: 0, hint: 'heading', hintConfidence: 2 }),
      block({ text: 'a = b + c - d', page: 1, readingOrder: 1, hint: 'formula', hintConfidence: 1 }),
    ];
    const sectionPaths = new Map<number, string[]>([[1, ['Chapter 1', 'Gradient Descent']]]);

    const eqs = extractEquationsWithSections(blocks, sectionPaths);

    expect(eqs).toHaveLength(1);
    expect(eqs[0].section_path).toEqual(['Chapter 1', 'Gradient Descent']);
  });

  it('defaults section_path to an empty array when the reading order is absent', () => {
    const blocks = [
      block({ text: 'a = b + c - d', page: 1, readingOrder: 9, hint: 'formula', hintConfidence: 1 }),
    ];

    const eqs = extractEquationsWithSections(blocks, new Map());

    expect(eqs[0].section_path).toEqual([]);
  });
});
