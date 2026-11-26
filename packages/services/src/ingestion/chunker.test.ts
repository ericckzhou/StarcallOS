import { describe, expect, it } from 'vitest';
import type { BlockHint, SegmentedBlock } from './layout';
import { segmentText } from './layout';
import { chunkBlocks, findRunningHeaderBlocks, splitOversized } from './chunker';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}
const para = (n: number, word = 'lorem') => Array.from({ length: n }, () => word).join(' ') + '.';

describe('chunkBlocks', () => {
  it('never crosses a section boundary and keeps the heading with its section', () => {
    order = 0;
    const blocks = [
      blk('1 Sets', 1, 'heading'), blk(para(40, 'set'), 1),
      blk('2 Graphs', 2, 'heading'), blk(para(40, 'graph'), 2),
    ];
    const { chunks } = chunkBlocks(blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text.startsWith('1 Sets\n')).toBe(true);
    expect(chunks[0].text).not.toContain('graph');
    expect(chunks[1].section_path).toEqual(['2 Graphs']);
    expect(chunks[1].heading).toBe('2 Graphs');
  });

  it('preserves page range, block range and ordering metadata', () => {
    order = 0;
    const blocks = [blk('Intro', 3, 'heading'), blk(para(20), 3), blk(para(20), 4)];
    const [c] = chunkBlocks(blocks).chunks;
    expect(c).toMatchObject({ ordinal: 0, page_start: 3, page_end: 4, block_start: 0, block_end: 2, block_count: 3 });
    expect(c.char_count).toBe(c.text.length);
    expect(c.chunk_key).toBe(`${c.text_hash}#0`);
  });

  it('splits at the target size with whole-block overlap inside a section', () => {
    order = 0;
    const blocks = [blk('Sec', 1, 'heading'), ...Array.from({ length: 12 }, (_, i) => blk(`Block ${i} ${para(25)}`, 1))];
    const { chunks } = chunkBlocks(blocks, [], { targetChars: 500, maxChars: 900, overlapChars: 200, minChars: 50 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.char_count).toBeLessThanOrEqual(900);
    // The last block of chunk N is repeated as the first block of chunk N+1.
    const lastOf0 = chunks[0].text.split('\n').at(-1)!;
    expect(chunks[1].text.split('\n')[0]).toBe(lastOf0);
    expect(chunks[1].block_start).toBe(chunks[0].block_end);
  });

  it('does not overlap when overlapChars is 0', () => {
    order = 0;
    const blocks = Array.from({ length: 10 }, (_, i) => blk(`B${i} ${para(25)}`, 1));
    const { chunks } = chunkBlocks(blocks, [], { targetChars: 400, overlapChars: 0, minChars: 10 });
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].block_start).toBe(chunks[i - 1].block_end + 1);
  });

  it('keeps a formula with the prose before it and the "where …" after it', () => {
    order = 0;
    const blocks = [
      blk('Sec', 1, 'heading'),
      blk(para(70), 1),
      blk('The sum is given by', 1),
      blk('Σ_{i=0}^{n} 2^i = 2^{n+1} − 1', 1, 'formula'),
      blk('where n is a natural number.', 1),
      blk(para(70, 'tail'), 1),
    ];
    const { chunks } = chunkBlocks(blocks, [], { targetChars: 420, maxChars: 1200, overlapChars: 0, minChars: 10 });
    const withFormula = chunks.find(c => c.text.includes('Σ_{i=0}^{n}'))!;
    expect(withFormula.has_formula).toBe(true);
    expect(withFormula.text).toContain('where n is a natural number.');
    expect(withFormula.text.startsWith('Σ')).toBe(false);
  });

  it('splits a single oversized block at sentence boundaries under maxChars', () => {
    order = 0;
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about trees.`).join(' ');
    const { chunks, diagnostics } = chunkBlocks([blk(long, 7)], [], { targetChars: 300, maxChars: 400 });
    expect(diagnostics.oversized_blocks_split).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.char_count).toBeLessThanOrEqual(400);
      expect(c.text.endsWith('.')).toBe(true);
      expect(c.page_start).toBe(7);
    }
    expect(chunks.map(c => c.text).join(' ')).toBe(long);
  });

  it('hard-splits a sentence longer than maxChars at whitespace', () => {
    const parts = splitOversized(`${'x'.repeat(50)} `.repeat(30).trim(), 200);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join(' ').replace(/\s+/g, '')).toBe('x'.repeat(1500));
  });

  it('drops empty and numeric figure-label blocks but keeps formulas', () => {
    order = 0;
    const blocks = [blk('Sec', 1, 'heading'), blk('2 5 1', 1), blk('   ', 1), blk('= 24', 1, 'formula'), blk(para(10), 1)];
    const { chunks, diagnostics } = chunkBlocks(blocks);
    expect(diagnostics.noise_blocks_dropped).toBe(2);
    expect(chunks[0].text).toContain('= 24');
    expect(chunks[0].text).not.toContain('2 5 1');
  });

  it('removes page-numbered running headers so sections do not reset every page', () => {
    order = 0;
    const blocks: SegmentedBlock[] = [blk('1.2 Mathematical induction', 1, 'heading'), blk(para(30), 1)];
    for (let p = 2; p <= 7; p++) {
      blocks.push(p % 2 === 0 ? blk(`${p * 2} CHAPTER 1. INDUCTION`, p, 'heading') : blk(`1.2. MATHEMATICAL INDUCTION ${p * 2}`, p, 'subheading'));
      blocks.push(blk(para(30), p));
    }
    // A genuine heading that appears on only two page tops is NOT a running header.
    blocks.push(blk('Exercises', 8, 'heading'), blk(para(5), 8), blk('Exercises', 9, 'heading'), blk(para(5), 9));
    expect(findRunningHeaderBlocks(blocks).size).toBe(6);
    // One-off odd-page header with a trailing page number IS; a leading-number heading is not.
    const oneOff = [blk('0.1. SETS 3', 10, 'subheading'), blk(para(5), 10), blk('1 INTRODUCTION', 11, 'heading'), blk(para(5), 11)];
    const found = findRunningHeaderBlocks(oneOff);
    expect([...found]).toEqual([oneOff[0].readingOrder]);
    const { chunks, diagnostics } = chunkBlocks(blocks.slice(0, -4), [], { targetChars: 5000, maxChars: 6000 });
    expect(diagnostics.running_header_blocks_dropped).toBe(6);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section_path).toEqual(['1.2 Mathematical induction']);
    expect(chunks[0].text).not.toContain('CHAPTER 1');
  });

  it('merges a tiny section tail into the previous chunk and drops heading-only sections', () => {
    order = 0;
    const blocks = [
      blk('Chapter 2', 1, 'heading'),
      blk('Trees', 1, 'heading'), blk(para(60), 1), blk('Short tail.', 1),
    ];
    const { chunks, diagnostics } = chunkBlocks(blocks, [], { targetChars: 300, maxChars: 800, overlapChars: 0, minChars: 100 });
    expect(diagnostics.heading_only_sections_dropped).toBe(1);
    expect(chunks.every(c => c.section_path[0] === 'Trees')).toBe(true);
    expect(chunks.at(-1)!.text.endsWith('Short tail.')).toBe(true);
    expect(chunks.at(-1)!.text.split('\n').length).toBeGreaterThan(1);
  });

  it('gives identical chunk text distinct, stable keys', () => {
    order = 0;
    const blocks = [blk('A', 1, 'heading'), blk('Exercises follow.', 1), blk('B', 2, 'heading'), blk('Exercises follow.', 2)];
    const a = chunkBlocks(blocks).chunks;
    order = 0;
    const b = chunkBlocks(blocks).chunks;
    expect(a.map(c => c.chunk_key)).toEqual(b.map(c => c.chunk_key));
    expect(new Set(a.map(c => c.chunk_key)).size).toBe(a.length);
  });

  it('handles empty input and text sources (single page)', () => {
    expect(chunkBlocks([]).chunks).toEqual([]);
    const blocks = segmentText('# Osmosis\n\nWater moves across a membrane toward higher solute.\n\n# Diffusion\n\nParticles spread out.');
    const { chunks } = chunkBlocks(blocks);
    expect(chunks.length).toBe(2);
    expect(chunks.every(c => c.page_start === 1 && c.page_end === 1)).toBe(true);
  });
});
