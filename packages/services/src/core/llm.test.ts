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
  type LlmTraceEvent,
  setLlmTraceSink,
  hashPrompt,
  toAnthropicPayload,
  normalizeLocalBaseUrl,
  listLocalModels,
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

describe('chatJSON — trace sink', () => {
  it('emits an ok event with retries and a stable prompt hash', async () => {
    const events: LlmTraceEvent[] = [];
    setLlmTraceSink(e => events.push(e));
    try {
      vi.useFakeTimers();
      groqCreate
        .mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 503 }))
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      const p = chatJSON(groqCfg, { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }] }, 'grader');
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.usage.retries).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ pass: 'grader', status: 'ok', retries: 1, promptTokens: 3, promptHash: hashPrompt('S') });
    } finally {
      vi.useRealTimers();
      setLlmTraceSink(null);
    }
  });

  it('emits an error event and rethrows; a throwing sink never breaks the call', async () => {
    const events: LlmTraceEvent[] = [];
    setLlmTraceSink(e => { events.push(e); throw new Error('sink boom'); });
    try {
      anthropicCreate.mockRejectedValueOnce(new Error('bad key'));
      await expect(chatJSON(anthropicCfg, { messages: [{ role: 'user', content: 'x' }] }, 'enrich')).rejects.toThrow('bad key');
      expect(events[0]).toMatchObject({ status: 'error', errorMessage: 'bad key', provider: 'anthropic' });

      anthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 7 },
      });
      const res = await chatJSON(anthropicCfg, { messages: [{ role: 'user', content: 'x' }] }, 'enrich');
      expect(res.usage.cacheReadTokens).toBe(7);
    } finally {
      setLlmTraceSink(null);
    }
  });
});

describe('toAnthropicPayload — prompt caching', () => {
  it('keeps plain string content when nothing is cached (unchanged wire shape)', () => {
    const p = toAnthropicPayload({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] }, null);
    expect(p.system).toBe('S');
    expect(p.messages).toEqual([{ role: 'user', content: 'U' }]);
  });

  it('marks cached system + user blocks and merges consecutive user messages', () => {
    const p = toAnthropicPayload({
      messages: [
        { role: 'system', content: 'S', cache: true },
        { role: 'user', content: 'CTX', cache: true },
        { role: 'user', content: 'ATTEMPT' },
      ],
    }, 'JSON ONLY');
    expect(p.system).toEqual([{ type: 'text', text: 'S\n\nJSON ONLY', cache_control: { type: 'ephemeral' } }]);
    expect(p.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'CTX', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'ATTEMPT' },
      ],
    }]);
  });

  it('never emits more than 4 cache breakpoints, keeping the latest', () => {
    const p = toAnthropicPayload({
      messages: [
        { role: 'system', content: 'S', cache: true },
        ...['a', 'b', 'c', 'd', 'e'].map(t => ({ role: 'user' as const, content: t, cache: true })),
      ],
    }, null);
    const blocks = p.messages[0].content as Array<{ text: string; cache_control?: unknown }>;
    expect(blocks.filter(b => b.cache_control).map(b => b.text)).toEqual(['c', 'd', 'e']);
  });
});

describe('chatJSON — local OpenAI-compatible provider', () => {
  const localCfg: ProviderConfig = { provider: 'local', apiKey: '', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1/' };

  it('POSTs to {baseUrl}/chat/completions with json_object and reads usage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"a":1}\n```' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }), { status: 200 }));
    try {
      const res = await chatJSON(localCfg, { messages: [{ role: 'user', content: 'x' }], responseFormat: 'json' }, 'grader');
      expect(res.content).toBe('{"a":1}');
      expect(res.usage).toMatchObject({ provider: 'local', promptTokens: 7, completionTokens: 3, totalTokens: 10 });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ model: 'llama3.1:8b', response_format: { type: 'json_object' }, stream: false, reasoning_effort: 'none' });
    } finally { fetchSpy.mockRestore(); }
  });

  it('retries without reasoning_effort when the server rejects it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unknown field reasoning_effort', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    try {
      const res = await chatJSON(localCfg, { messages: [{ role: 'user', content: 'x' }] }, 'grader');
      expect(res.content).toBe('ok');
      expect(res.usage.retries).toBe(1);
      expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body))).not.toHaveProperty('reasoning_effort');
    } finally { fetchSpy.mockRestore(); }
  });

  it('turns a refused connection into an actionable error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    try {
      await expect(chatJSON(localCfg, { messages: [{ role: 'user', content: 'x' }] }, 'grader')).rejects.toThrow(/could not be reached.*ollama serve/);
    } finally { fetchSpy.mockRestore(); }
  });

  it('surfaces HTTP errors with the server detail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('model "nope" not found', { status: 404 }));
    try {
      await expect(chatJSON({ ...localCfg, model: 'nope' }, { messages: [{ role: 'user', content: 'x' }] }, 'grader')).rejects.toThrow(/HTTP 404: model "nope" not found/);
    } finally { fetchSpy.mockRestore(); }
  });

  it('normalizes base URLs and lists models', async () => {
    expect(normalizeLocalBaseUrl(' http://localhost:8080/v1/ ')).toBe('http://localhost:8080/v1');
    expect(normalizeLocalBaseUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeLocalBaseUrl('http://user:pw@host/v1')).toBeNull();
    expect(normalizeLocalBaseUrl('not a url')).toBeNull();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }, { id: 3 }] })));
    try {
      expect(await listLocalModels('http://127.0.0.1:11434/v1')).toEqual(['qwen2.5:7b']);
    } finally { fetchSpy.mockRestore(); }
  });
});

describe('chatJSON — local provider output checks', () => {
  const cfg: ProviderConfig = { provider: 'local', apiKey: '', model: 'qwen3.5:4b', baseUrl: 'http://127.0.0.1:11434/v1' };
  it.each([
    [{ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, /empty response/],
    [{ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }, /cut off at the token limit.*finish_reason=length/],
  ])('reports a truncated/empty answer instead of returning it (%#)', async (body, re) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(body)));
    try {
      await expect(chatJSON(cfg, { messages: [{ role: 'user', content: 'x' }] }, 'grader')).rejects.toThrow(re);
    } finally { spy.mockRestore(); }
  });

  it('does not call a responding-but-broken server "unreachable"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not json at all', { status: 200 }));
    try {
      const err = (await chatJSON(cfg, { messages: [{ role: 'user', content: 'x' }] }, 'grader').catch(e => e)) as Error;
      expect(err.message).not.toMatch(/could not be reached/);
    } finally { spy.mockRestore(); }
  });
});
