import { describe, expect, it } from 'vitest';
import { __layoutTest, stripMarkdownMarkers, segmentText } from './layout';

function item(str: string, x: number, width: number, fontSize = 10, fontName = 'Body') {
  return { str, x, y: 700, width, fontSize, fontName, page: 1 };
}

describe('layout typography helpers', () => {
  it('reconstructs spaces from x-gaps between PDF text items', () => {
    const line = __layoutTest.makeLine([
      item('Gradient', 10, 42),
      item('Descent', 70, 36),
    ]);

    expect(line.text).toBe('Gradient Descent');
  });

  it('keeps soft-hyphenated word fragments joined', () => {
    const line = __layoutTest.makeLine([
      item('Few-', 10, 22),
      item('Shot', 38, 22),
    ]);

    expect(line.text).toBe('Few-Shot');
  });

  it('classifies large bold isolated lines as strong headings with rich signals', () => {
    const line = __layoutTest.makeLine([
      item('1.2', 72, 18, 16, 'Heading-Bold'),
      item('Processes', 100, 70, 16, 'Heading-Bold'),
    ]);
    const block = __layoutTest.groupIntoBlocks([line], 10)[0];
    block.yGapAbove = 22;
    block.yGapBelow = 20;

    const seg = __layoutTest.classify(block, 10, false, 0, 0, 792);

    expect(seg.hint).toBe('heading');
    expect(seg.hintConfidence).toBe(2);
    expect(seg.signals.fontSizeRatio).toBeCloseTo(1.6);
    expect(seg.signals.isBold).toBe(true);
    expect(seg.signals.isIsolatedLine).toBe(true);
    expect(seg.signals.headingDepth).toBe(2);
  });

  it('downgrades caption-like large text instead of treating it as a heading', () => {
    const line = __layoutTest.makeLine([
      item('Figure 2.1: Process states', 72, 180, 16, 'Heading-Bold'),
    ]);
    const block = __layoutTest.groupIntoBlocks([line], 10)[0];

    const seg = __layoutTest.classify(block, 10, false, 0, 0, 792);

    expect(seg.hint).toBe('caption');
  });

  it('detects short isolated ALL-CAPS lines as headings even at body font size', () => {
    const line = __layoutTest.makeLine([
      item('PROCESS SCHEDULING', 72, 120, 10, 'Body'),
    ]);
    const block = __layoutTest.groupIntoBlocks([line], 10)[0];
    block.yGapAbove = 18;
    block.yGapBelow = 16;

    const seg = __layoutTest.classify(block, 10, false, 0, 0, 792);

    expect(seg.hint === 'heading' || seg.hint === 'subheading').toBe(true);
    expect(seg.signals.isAllCaps).toBe(true);
    expect(seg.signals.headingConfidence ?? 0).toBeGreaterThan(0.3);
  });

  it('assigns higher headingConfidence to a strong heading than to body prose', () => {
    const headLine = __layoutTest.makeLine([item('Backpropagation', 72, 90, 16, 'Heading-Bold')]);
    const headBlock = __layoutTest.groupIntoBlocks([headLine], 10)[0];
    headBlock.yGapAbove = 22;
    const headSeg = __layoutTest.classify(headBlock, 10, false, 0, 0, 792);

    const bodyLine = __layoutTest.makeLine([
      item('This section explains how the gradient flows backward through each layer in turn.', 72, 360, 10, 'Body'),
    ]);
    const bodyBlock = __layoutTest.groupIntoBlocks([bodyLine], 10)[0];
    const bodySeg = __layoutTest.classify(bodyBlock, 10, false, 0, 0, 792);

    expect(headSeg.signals.headingConfidence ?? 0).toBeGreaterThan(bodySeg.signals.headingConfidence ?? 0);
  });
});

describe('stripMarkdownMarkers', () => {
  it('strips leading block markers (heading / bullet / number / quote)', () => {
    expect(stripMarkdownMarkers('## React Components')).toBe('React Components');
    expect(stripMarkdownMarkers('- useState')).toBe('useState');
    expect(stripMarkdownMarkers('* sigmoid')).toBe('sigmoid');
    expect(stripMarkdownMarkers('3. third item')).toBe('third item');
    expect(stripMarkdownMarkers('> a quote')).toBe('a quote');
  });

  it('strips doubled emphasis and inline code, leaving the words', () => {
    expect(stripMarkdownMarkers('the **bold** word')).toBe('the bold word');
    expect(stripMarkdownMarkers('an __underline__ term')).toBe('an underline term');
    expect(stripMarkdownMarkers('call `useEffect` here')).toBe('call useEffect here');
  });

  it('leaves single * and _ alone (likely literals in prose)', () => {
    expect(stripMarkdownMarkers('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(stripMarkdownMarkers('an_identifier_name')).toBe('an_identifier_name');
  });

  it('leaves marker-free prose untouched', () => {
    expect(stripMarkdownMarkers('Gradient descent is an algorithm.')).toBe('Gradient descent is an algorithm.');
  });
});

describe('segmentText with Markdown', () => {
  it('classifies a Markdown heading but stores marker-free block text', () => {
    const blocks = segmentText('## Large Language Models\n\nThey predict the next token.');
    const heading = blocks.find(b => b.hint === 'heading' || b.hint === 'subheading');
    expect(heading?.text).toBe('Large Language Models'); // no leading "## "
    const body = blocks.find(b => b.hint === 'body');
    expect(body?.text).toContain('predict the next token');
  });

  it('keeps bullet items as list_item with the bullet stripped', () => {
    const blocks = segmentText('- one\n- two');
    expect(blocks.every(b => b.hint === 'list_item')).toBe(true);
    expect(blocks.map(b => b.text)).toEqual(['one', 'two']);
  });
});
