import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider SDKs so chatJSON's own logic (token caps, JSON fence
// stripping, usage recording, error enrichment) can be exercised without any
// network call. vi.hoisted lets the factories reference these shared spies.
const { groqCreate, anthropicCreate } = vi.hoisted(() => ({
  groqCreate: vi.fn(),
  anthropicCreate: vi.fn(),
}));

vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: groqCreate } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
    constructor(_opts: unknown) {}
  },
}));

import {
  chatJSON,
  resetUsageStats,
  getUsageStats,
  DEFAULT_MODELS,
  type ProviderConfig,
} from './llm';

const groqCfg: ProviderConfig = { provider: 'groq', apiKey: 'k', model: 'llama-3.1-8b-instant' };
const anthropicCfg: ProviderConfig = { provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5-20251001' };

beforeEach(() => {
  vi.clearAllMocks();
  resetUsageStats();
});

describe('chatJSON — groq path', () => {
  it('caps max_tokens at the free-tier limit and forwards json response format', async () => {
    groqCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await chatJSON(
      groqCfg,
      { messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json', maxTokens: 99999 },
      'enrich',
    );

    expect(res.content).toBe('{"ok":true}');
    expect(res.usage.totalTokens).toBe(15);
    expect(groqCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 4096,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('honors a smaller requested max_tokens below the cap', async () => {
    groqCreate.mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await chatJSON(groqCfg, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 }, 'tasks');

    expect(groqCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1000 }));
  });

  it('enriches non-retryable errors with pass/provider/model context', async () => {
    groqCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(
      chatJSON(groqCfg, { messages: [{ role: 'user', content: 'hi' }] }, 'concepts'),
    ).rejects.toMatchObject({ passName: 'concepts', provider: 'groq', llmModel: 'llama-3.1-8b-instant' });
  });
});

describe('chatJSON — anthropic path', () => {
  it('strips markdown fences from JSON responses and sums token usage', async () => {
    anthropicCreate.mockResolvedValue({
      usage: { input_tokens: 8, output_tokens: 4 },
      content: [{ type: 'text', text: '```json\n{"a":1}\n```' }],
    });

    const res = await chatJSON(
      anthropicCfg,
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }], responseFormat: 'json' },
      'grader',
    );

    expect(res.content).toBe('{"a":1}');
    expect(res.usage.totalTokens).toBe(12);
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('valid JSON only') }),
    );
  });

  it('does not strip fences in text mode', async () => {
    anthropicCreate.mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: '```still text```' }],
    });

    const res = await chatJSON(
      anthropicCfg,
      { messages: [{ role: 'user', content: 'u' }], responseFormat: 'text' },
      'structure',
    );

    expect(res.content).toBe('```still text```');
  });

  it('enriches errors with context', async () => {
    anthropicCreate.mockRejectedValue(new Error('overloaded'));

    await expect(
      chatJSON(anthropicCfg, { messages: [{ role: 'user', content: 'u' }] }, 'chunker'),
    ).rejects.toMatchObject({ passName: 'chunker', provider: 'anthropic' });
  });
});

describe('usage accumulator', () => {
  it('starts empty after reset', () => {
    resetUsageStats();
    expect(getUsageStats()).toEqual({ byPass: {}, total: 0, calls: 0 });
  });

  it('accumulates per-pass totals across calls', async () => {
    groqCreate.mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await chatJSON(groqCfg, { messages: [{ role: 'user', content: 'a' }] }, 'enrich');
    await chatJSON(groqCfg, { messages: [{ role: 'user', content: 'b' }] }, 'enrich');

    const snap = getUsageStats();
    expect(snap.calls).toBe(2);
    expect(snap.total).toBe(30);
    expect(snap.byPass['enrich']).toEqual({ total: 30, calls: 2, prompt: 20, completion: 10 });
  });

  it('returns a defensive copy that cannot mutate internal state', () => {
    resetUsageStats();
    const snap = getUsageStats();
    snap.total = 999;
    snap.byPass['hack'] = { total: 1, calls: 1, prompt: 1, completion: 1 };

    expect(getUsageStats().total).toBe(0);
    expect(getUsageStats().byPass['hack']).toBeUndefined();
  });
});

describe('DEFAULT_MODELS', () => {
  it('defines heavy and light models for every provider', () => {
    for (const provider of ['groq', 'anthropic'] as const) {
      expect(DEFAULT_MODELS[provider].heavy.length).toBeGreaterThan(0);
      expect(DEFAULT_MODELS[provider].light.length).toBeGreaterThan(0);
    }
  });
});
