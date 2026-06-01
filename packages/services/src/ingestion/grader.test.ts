import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseGradeResult, gradeResponse, type GradeInput } from './grader';
import type { ProviderConfig } from '../core/llm';

// ─── parseGradeResult (no LLM, pure parsing) ─────────────────────────────────

describe('parseGradeResult', () => {
  it('preserves well-formed output from the LLM', () => {
    const result = parseGradeResult({
      score: 'understood',
      compression_stage: 3,
      gaps_detected: ['Did not connect to CAP theorem.', 'No failure mode mentioned.'],
      misconceptions_detected: [],
      reasoning: 'Explained in own words accurately.',
    });
    expect(result.score).toBe('understood');
    expect(result.compression_stage).toBe(3);
    expect(result.gaps_detected).toEqual(['Did not connect to CAP theorem.', 'No failure mode mentioned.']);
    expect(result.misconceptions_detected).toEqual([]);
    expect(result.reasoning).toBe('Explained in own words accurately.');
  });

  it('defaults score to "gap" when field is absent', () => {
    expect(parseGradeResult({}).score).toBe('gap');
  });

  it('defaults compression_stage to 0 when field is absent', () => {
    expect(parseGradeResult({}).compression_stage).toBe(0);
  });

  it('defaults reasoning to empty string when field is absent', () => {
    expect(parseGradeResult({}).reasoning).toBe('');
  });

  it('defaults misconceptions_detected to [] when field is absent', () => {
    expect(parseGradeResult({}).misconceptions_detected).toEqual([]);
  });

  // Core invariant: gaps_detected must NEVER be empty.
  it('enforces non-empty gaps_detected when LLM omits the field', () => {
    const result = parseGradeResult({ score: 'understood', compression_stage: 4 });
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('enforces non-empty gaps_detected when LLM returns an empty array', () => {
    const result = parseGradeResult({ score: 'understood', gaps_detected: [] });
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('keeps non-empty gaps_detected from the LLM unchanged', () => {
    const gaps = ['Missed the quorum requirement.'];
    const result = parseGradeResult({ score: 'gap', gaps_detected: gaps });
    expect(result.gaps_detected).toEqual(gaps);
  });

  it('handles completely empty JSON object gracefully', () => {
    const result = parseGradeResult({});
    expect(result.score).toBe('gap');
    expect(result.compression_stage).toBe(0);
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('handles a non-object value gracefully (null, string, number)', () => {
    for (const bad of [null, 'not an object', 42]) {
      const result = parseGradeResult(bad);
      expect(result.score).toBe('gap');
      expect(result.gaps_detected.length).toBeGreaterThan(0);
    }
  });

  it('accepted all four valid score values', () => {
    for (const score of ['understood', 'recognizes', 'gap', 'misconception'] as const) {
      expect(parseGradeResult({ score })).toMatchObject({ score });
    }
  });

  it('accepted all valid compression stage values 0–5', () => {
    for (const stage of [0, 1, 2, 3, 4, 5] as const) {
      expect(parseGradeResult({ compression_stage: stage })).toMatchObject({ compression_stage: stage });
    }
  });
});

// ─── gradeResponse (mocked chatJSON) ─────────────────────────────────────────

vi.mock('../core/llm', () => ({
  chatJSON: vi.fn(),
}));

import { chatJSON } from '../core/llm';
const mockChatJSON = vi.mocked(chatJSON);

const config: ProviderConfig = { provider: 'groq', apiKey: 'test-key', model: 'llama-test' };

const input: GradeInput = {
  concept_name: 'Consistent Hashing',
  concept_definition: 'A technique that maps keys to nodes minimising remapping on membership changes.',
  task_kind: 'definition',
  task_prompt: 'Explain consistent hashing in your own words.',
  user_response: 'It maps keys onto a ring so that only a small fraction of keys move when a node joins or leaves.',
};

describe('gradeResponse', () => {
  beforeEach(() => { mockChatJSON.mockReset(); });

  it('calls chatJSON with pass name "grader" and JSON response format', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({
        score: 'recognizes', compression_stage: 2,
        gaps_detected: ['Did not mention virtual nodes.'],
        misconceptions_detected: [],
        reasoning: 'Accurate but definition-level.',
      }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 20, totalTokens: 30, durationMs: 100 },
    });

    await gradeResponse(config, input);

    expect(mockChatJSON).toHaveBeenCalledOnce();
    const [, req, passName] = mockChatJSON.mock.calls[0];
    expect(passName).toBe('grader');
    expect(req.responseFormat).toBe('json');
  });

  it('uses temperature 0.1 for strict, consistent grading', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({ score: 'gap', compression_stage: 1, gaps_detected: ['Missing ring metaphor.'], misconceptions_detected: [], reasoning: '' }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 50 },
    });

    await gradeResponse(config, input);

    const [, req] = mockChatJSON.mock.calls[0];
    expect(req.temperature).toBe(0.1);
  });

  it('includes concept name, definition, task kind, prompt, and user response in the user message', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({ score: 'understood', compression_stage: 3, gaps_detected: ['Could name a failure mode.'], misconceptions_detected: [], reasoning: '' }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 100, completionTokens: 30, totalTokens: 130, durationMs: 200 },
    });

    await gradeResponse(config, input);

    const [, req] = mockChatJSON.mock.calls[0];
    const userMsg = req.messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Consistent Hashing');
    expect(userMsg).toContain('A technique that maps keys');
    expect(userMsg).toContain('definition');
    expect(userMsg).toContain('Explain consistent hashing');
    expect(userMsg).toContain('It maps keys onto a ring');
  });

  it('returns the parsed GradeResult from LLM content', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({
        score: 'understood', compression_stage: 4,
        gaps_detected: ['No failure mode surfaced.'],
        misconceptions_detected: [],
        reasoning: 'Concise and accurate.',
      }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 80, completionTokens: 25, totalTokens: 105, durationMs: 180 },
    });

    const result = await gradeResponse(config, input);

    expect(result.score).toBe('understood');
    expect(result.compression_stage).toBe(4);
    expect(result.gaps_detected).toEqual(['No failure mode surfaced.']);
    expect(result.reasoning).toBe('Concise and accurate.');
  });

  it('never returns empty gaps_detected even when LLM returns []', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({ score: 'understood', compression_stage: 5, gaps_detected: [], misconceptions_detected: [], reasoning: '' }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 50 },
    });

    const result = await gradeResponse(config, input);
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('handles malformed JSON from the LLM without throwing', async () => {
    mockChatJSON.mockResolvedValue({
      content: 'not valid json at all',
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 5, completionTokens: 5, totalTokens: 10, durationMs: 30 },
    });

    const result = await gradeResponse(config, input);
    expect(result.score).toBe('gap');
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('handles empty content from the LLM without throwing', async () => {
    mockChatJSON.mockResolvedValue({
      content: '',
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 5, completionTokens: 0, totalTokens: 5, durationMs: 20 },
    });

    const result = await gradeResponse(config, input);
    expect(result.score).toBe('gap');
    expect(result.compression_stage).toBe(0);
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });
});
