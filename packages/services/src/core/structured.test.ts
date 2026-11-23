import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const { anthropicCreate, groqCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  groqCreate: vi.fn(),
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

import { chatStructured, LlmParseError, toProviderJsonSchema } from './structured';
import { setLlmTraceSink, type ProviderConfig } from './llm';

const anthropicCfg: ProviderConfig = { provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5-20251001' };
const groqCfg: ProviderConfig = { provider: 'groq', apiKey: 'k', model: 'llama-3.1-8b-instant' };
const Schema = z.object({ score: z.enum(['a', 'b']), n: z.number().int(), note: z.string().optional().default('') });
const msgs = { messages: [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'U' }] };
const usage = { input_tokens: 1, output_tokens: 1 };
const groqOk = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

beforeEach(() => vi.clearAllMocks());

describe('chatStructured', () => {
  it('forces a single Anthropic tool with the schema and reads tool_use input', async () => {
    anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', input: { score: 'a', n: 2 } }], usage });
    const res = await chatStructured(anthropicCfg, msgs, 'grader', { schema: Schema, name: 'record_grade' });

    expect(res).toMatchObject({ data: { score: 'a', n: 2, note: '' }, repaired: false });
    const call = anthropicCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'record_grade' });
    expect(call.tools[0].input_schema.type).toBe('object');
    expect(call.tools[0].input_schema.required).toEqual(expect.arrayContaining(['score', 'n']));
    expect(call.tools[0].input_schema.required).not.toContain('note');
  });

  it('repairs once on Groq when the first output fails validation', async () => {
    groqCreate
      .mockResolvedValueOnce(groqOk('{"score":"zzz","n":1}'))
      .mockResolvedValueOnce(groqOk('{"score":"b","n":1}'));
    const res = await chatStructured(groqCfg, msgs, 'lazy_tasks', { schema: Schema, name: 't' });

    expect(res).toMatchObject({ data: { score: 'b' }, repaired: true });
    const repair = groqCreate.mock.calls[1][0];
    expect(repair.temperature).toBe(0);
    expect(repair.messages.at(-2)).toEqual({ role: 'assistant', content: '{"score":"zzz","n":1}' });
    expect(repair.messages.at(-1).content).toContain('score');
    // Groq has no schema enforcement for the curated models: json_object only.
    expect(repair.response_format).toEqual({ type: 'json_object' });
  });

  it('throws LlmParseError after a failed repair', async () => {
    groqCreate.mockResolvedValue(groqOk('nope'));
    const err = await chatStructured(groqCfg, msgs, 'p', { schema: Schema, name: 't' }).catch(e => e);
    expect(err).toBeInstanceOf(LlmParseError);
    expect(err.passName).toBe('p');
    expect(groqCreate).toHaveBeenCalledTimes(2);
  });

  it('emits a JSON Schema without the $schema key', () => {
    const js = toProviderJsonSchema(Schema);
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe('object');
  });
});

describe('chatStructured — trace on final failure', () => {
  it('records a status=error trace event when the repair also fails', async () => {
    const events: Array<{ pass: string; status: string; errorMessage: string | null }> = [];
    setLlmTraceSink(e => events.push(e));
    try {
      groqCreate.mockResolvedValue(groqOk('nope'));
      await chatStructured(groqCfg, msgs, 'grader', { schema: Schema, name: 't' }).catch(() => {});
      const errors = events.filter(e => e.status === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ pass: 'grader' });
      expect(errors[0].errorMessage).toMatch(/failed validation after repair/);
    } finally { setLlmTraceSink(null); }
  });
});
