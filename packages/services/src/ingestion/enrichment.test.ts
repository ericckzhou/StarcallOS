import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEnricher } from './enrichment';
import type { SegmentedBlock } from './layout';

vi.mock('../core/llm', () => ({ chatJSON: vi.fn() }));

import { chatJSON } from '../core/llm';
const mockChat = vi.mocked(chatJSON);

const fakeUsage = { pass: 'enrich', provider: 'groq' as const, model: 'm', promptTokens: 10, completionTokens: 20, totalTokens: 30, durationMs: 50 };
const cfg = { provider: 'groq' as const, apiKey: 'k', model: 'm' };

function blk(readingOrder: number, text: string, hint = 'body', page = 1): SegmentedBlock {
  return {
    text, page, readingOrder, hint: hint as never,
    hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false, headingConfidence: 0 },
  };
}

describe('runEnricher', () => {
  beforeEach(() => mockChat.mockReset());

  it('returns [] immediately for an empty block list without calling LLM', async () => {
    const result = await runEnricher(cfg, []);
    expect(result).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns one chunk per input block', async () => {
    const blocks = [blk(0, 'Alpha.'), blk(1, 'Beta.')];
    mockChat.mockResolvedValue({
      content: JSON.stringify({ enriched: [
        { idx: 0, block_type: 'definition', claim: 'Alpha claim', assumptions: [], example_quote: null },
        { idx: 1, block_type: 'mechanism', claim: null,         assumptions: [], example_quote: 'Beta.' },
      ]}),
      usage: fakeUsage,
    });

    const result = await runEnricher(cfg, blocks);
    expect(result).toHaveLength(2);
  });

  it('uses LLM block_type when valid', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ enriched: [{ idx: 0, block_type: 'theorem', claim: null, assumptions: [], example_quote: null }] }),
      usage: fakeUsage,
    });
    const [chunk] = await runEnricher(cfg, [blk(0, 'If P then Q.')]);
    expect(chunk.block_type).toBe('theorem');
  });

  it('falls back to hint prior when LLM returns an invalid block_type', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ enriched: [{ idx: 0, block_type: 'made_up_type', claim: null, assumptions: [], example_quote: null }] }),
      usage: fakeUsage,
    });
    // hint='body' → prior='mechanism'
    const [chunk] = await runEnricher(cfg, [blk(0, 'Some body text.', 'body')]);
    expect(chunk.block_type).toBe('mechanism');
  });

  it('falls back to hint prior when LLM omits the block entry entirely', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ enriched: [] }),
      usage: fakeUsage,
    });
    const [chunk] = await runEnricher(cfg, [blk(0, 'Formula here.', 'formula')]);
    expect(chunk.block_type).toBe('formula'); // hint=formula → prior=formula
  });

  it('recovers from malformed JSON without throwing', async () => {
    mockChat.mockResolvedValue({ content: 'not valid json }{', usage: fakeUsage });
    const result = await runEnricher(cfg, [blk(0, 'Some text.')]);
    expect(result).toHaveLength(1);
    expect(result[0].block_type).toBe('mechanism'); // falls back to hint prior
  });

  it('recovers from truncated JSON without throwing', async () => {
    mockChat.mockResolvedValue({ content: '{"enriched":[{"idx":0,"block_type":"defin', usage: fakeUsage });
    const result = await runEnricher(cfg, [blk(0, 'Truncated.')]);
    expect(result).toHaveLength(1);
    expect(result[0].block_type).toBe('mechanism');
  });

  it('uses the hint prior correctly for all known hint types', async () => {
    const hints = ['heading', 'subheading', 'body', 'formula', 'list_item', 'caption', 'footnote', 'unknown'] as const;
    const expected = ['transition', 'transition', 'mechanism', 'formula', 'procedure', 'transition', 'assumption', 'mechanism'];

    for (let i = 0; i < hints.length; i++) {
      mockChat.mockResolvedValue({ content: JSON.stringify({ enriched: [] }), usage: fakeUsage });
      const [chunk] = await runEnricher(cfg, [blk(0, 'text', hints[i])]);
      expect(chunk.block_type).toBe(expected[i]);
    }
  });

  it('uses pass name "enrich" when calling chatJSON', async () => {
    mockChat.mockResolvedValue({ content: JSON.stringify({ enriched: [] }), usage: fakeUsage });
    await runEnricher(cfg, [blk(0, 'text')]);
    expect(mockChat.mock.calls[0][2]).toBe('enrich');
  });

  it('handles multiple batches when blocks exceed ENRICH_BATCH_CHARS', async () => {
    // Each block ~4100 chars — forces one block per batch
    const longText = 'x'.repeat(4100);
    const blocks = [blk(0, longText), blk(1, longText)];
    mockChat
      .mockResolvedValueOnce({ content: JSON.stringify({ enriched: [{ idx: 0, block_type: 'claim', claim: null, assumptions: [], example_quote: null }] }), usage: fakeUsage })
      .mockResolvedValueOnce({ content: JSON.stringify({ enriched: [{ idx: 1, block_type: 'evidence', claim: null, assumptions: [], example_quote: null }] }), usage: fakeUsage });

    const result = await runEnricher(cfg, blocks);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0].block_type).toBe('claim');
    expect(result[1].block_type).toBe('evidence');
  });
});
