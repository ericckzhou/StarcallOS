import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeCentrality, runStructureExtractor, runChunker } from './extraction';

vi.mock('../core/llm', () => ({ chatJSON: vi.fn() }));
import { chatJSON } from '../core/llm';
const mockChat = vi.mocked(chatJSON);

const fakeUsage = { pass: 'x', provider: 'groq' as const, model: 'm', promptTokens: 5, completionTokens: 5, totalTokens: 10, durationMs: 20 };
const cfg = { provider: 'groq' as const, apiKey: 'k', model: 'm' };

// ─── computeCentrality (pure, no LLM) ─────────────────────────────────────────

describe('computeCentrality', () => {
  it('assigns 0 to all nodes when there are no edges', () => {
    const result = computeCentrality([1, 2, 3], []);
    expect(result.get(1)).toBe(0);
    expect(result.get(2)).toBe(0);
    expect(result.get(3)).toBe(0);
  });

  it('normalises by max degree so the most-connected node scores 1.0', () => {
    // Node 1 connects to 2 and 3 (degree 2); nodes 2,3 have degree 1 each.
    const result = computeCentrality([1, 2, 3], [
      { from_id: 1, to_id: 2 },
      { from_id: 1, to_id: 3 },
    ]);
    expect(result.get(1)).toBe(1.0);
    expect(result.get(2)).toBe(0.5);
    expect(result.get(3)).toBe(0.5);
  });

  it('counts both directions of an edge for each endpoint', () => {
    const result = computeCentrality([10, 20], [{ from_id: 10, to_id: 20 }]);
    expect(result.get(10)).toBe(1.0);
    expect(result.get(20)).toBe(1.0);
  });

  it('returns an entry for every input conceptId', () => {
    const result = computeCentrality([5, 6, 7], [{ from_id: 5, to_id: 6 }]);
    expect(result.has(7)).toBe(true);
  });
});

// ─── runStructureExtractor — JSON parse recovery ───────────────────────────────

describe('runStructureExtractor JSON recovery', () => {
  beforeEach(() => mockChat.mockReset());

  it('returns [] on malformed JSON without throwing', async () => {
    mockChat.mockResolvedValue({ content: 'not json', usage: fakeUsage });
    await expect(runStructureExtractor(cfg, [{ page: 1, text: 'Chapter 1' }])).resolves.toEqual([]);
  });

  it('returns [] when sections field is missing', async () => {
    mockChat.mockResolvedValue({ content: '{}', usage: fakeUsage });
    await expect(runStructureExtractor(cfg, [{ page: 1, text: 'x' }])).resolves.toEqual([]);
  });

  it('returns [] when sections is not an array', async () => {
    mockChat.mockResolvedValue({ content: '{"sections": "oops"}', usage: fakeUsage });
    await expect(runStructureExtractor(cfg, [{ page: 1, text: 'x' }])).resolves.toEqual([]);
  });

  it('returns parsed sections on valid output', async () => {
    const sections = [{ heading: 'Intro', level: 1, page_start: 1, page_end: 3 }];
    mockChat.mockResolvedValue({ content: JSON.stringify({ sections }), usage: fakeUsage });
    const result = await runStructureExtractor(cfg, [{ page: 1, text: 'Intro text' }]);
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe('Intro');
  });
});

// ─── runChunker — JSON parse recovery ─────────────────────────────────────────

describe('runChunker JSON recovery', () => {
  beforeEach(() => mockChat.mockReset());

  it('returns [] on malformed JSON without throwing', async () => {
    mockChat.mockResolvedValue({ content: '{bad json}', usage: fakeUsage });
    await expect(runChunker(cfg, [{ page: 1, text: 'some text' }])).resolves.toEqual([]);
  });

  it('returns [] when blocks is not an array', async () => {
    mockChat.mockResolvedValue({ content: '{"blocks": null}', usage: fakeUsage });
    await expect(runChunker(cfg, [{ page: 1, text: 'x' }])).resolves.toEqual([]);
  });

  it('returns chunks on valid output', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ blocks: [{
        content: 'A definition.',
        page_start: 1, page_end: 1,
        block_type: 'definition',
        claim: null, assumptions: [], example_quote: null,
      }]}),
      usage: fakeUsage,
    });
    const result = await runChunker(cfg, [{ page: 1, text: 'A definition.' }]);
    expect(result).toHaveLength(1);
    expect(result[0].block_type).toBe('definition');
  });
});
