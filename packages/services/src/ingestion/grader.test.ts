import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseGradeResult, gradeResponse, aggregateGrades, GraderOutputSchema, isBorderlineGrade, GRADER_PROMPT_HASH, type GradeInput } from './grader';
import { CONTRACT_VERSION } from '../core/version';
import type { ProviderConfig } from '../core/llm';
import { LlmParseError } from '../core/structured';

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

vi.mock('../core/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/llm')>()),
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
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 20, totalTokens: 30, durationMs: 100, retries: 0, cacheReadTokens: 0 },
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
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 50, retries: 0, cacheReadTokens: 0 },
    });

    await gradeResponse(config, input);

    const [, req] = mockChatJSON.mock.calls[0];
    expect(req.temperature).toBe(0.1);
  });

  it('includes concept name, definition, task kind, prompt, and user response in the user message', async () => {
    mockChatJSON.mockResolvedValue({
      content: JSON.stringify({ score: 'understood', compression_stage: 3, gaps_detected: ['Could name a failure mode.'], misconceptions_detected: [], reasoning: '' }),
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 100, completionTokens: 30, totalTokens: 130, durationMs: 200, retries: 0, cacheReadTokens: 0 },
    });

    await gradeResponse(config, input);

    const [, req] = mockChatJSON.mock.calls[0];
    const userMsg = req.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content).join('\n\n');
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
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 80, completionTokens: 25, totalTokens: 105, durationMs: 180, retries: 0, cacheReadTokens: 0 },
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
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 50, retries: 0, cacheReadTokens: 0 },
    });

    const result = await gradeResponse(config, input);
    expect(result.gaps_detected.length).toBeGreaterThan(0);
  });

  it('repairs malformed JSON with one follow-up call instead of fabricating a grade', async () => {
    const usage = { pass: 'grader', provider: 'groq' as const, model: 'llama-test', promptTokens: 5, completionTokens: 5, totalTokens: 10, durationMs: 30, retries: 0, cacheReadTokens: 0 };
    mockChatJSON
      .mockResolvedValueOnce({ content: 'not valid json at all', usage })
      .mockResolvedValueOnce({
        content: JSON.stringify({ score: 'recognizes', compression_stage: 2, gaps_detected: ['x'], reasoning: 'r' }),
        usage,
      });

    const result = await gradeResponse(config, input);
    expect(result.score).toBe('recognizes');
    expect(mockChatJSON).toHaveBeenCalledTimes(2);
    const [, repairReq, repairPass] = mockChatJSON.mock.calls[1];
    expect(repairPass).toBe('grader:repair');
    const last = repairReq.messages[repairReq.messages.length - 1].content as string;
    expect(last).toContain('invalid JSON');
  });

  it('rejects an out-of-enum score and repairs it', async () => {
    const usage = { pass: 'grader', provider: 'groq' as const, model: 'llama-test', promptTokens: 5, completionTokens: 5, totalTokens: 10, durationMs: 30, retries: 0, cacheReadTokens: 0 };
    mockChatJSON
      .mockResolvedValueOnce({ content: JSON.stringify({ score: 'excellent', compression_stage: 9 }), usage })
      .mockResolvedValueOnce({ content: JSON.stringify({ score: 'understood', compression_stage: 4, gaps_detected: ['next'] }), usage });

    const result = await gradeResponse(config, input);
    expect(result.score).toBe('understood');
    const last = mockChatJSON.mock.calls[1][1].messages.at(-1)!.content as string;
    expect(last).toContain('score');
    expect(last).toContain('compression_stage');
  });

  it('throws LlmParseError (never records a fake gap) when the repair also fails', async () => {
    mockChatJSON.mockResolvedValue({
      content: '',
      usage: { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 5, completionTokens: 0, totalTokens: 5, durationMs: 20, retries: 0, cacheReadTokens: 0 },
    });

    await expect(gradeResponse(config, input)).rejects.toBeInstanceOf(LlmParseError);
    expect(mockChatJSON).toHaveBeenCalledTimes(2);
  });
});

// ─── Source grounding (parse-level) ──────────────────────────────────────────

describe('parseGradeResult — grounding gate', () => {
  const grounded = {
    score: 'understood', compression_stage: 3,
    gaps_detected: ['x'], misconceptions_detected: [],
    grounding_score: 0.7,
    unsupported_claims: [{ claim: 'PUT is always edge-cached', reason: 'not in source', severity: 'major' }],
    reasoning: 'ok',
  };

  it('forces grounding to "not assessed" when no context was given (hasContext=false)', () => {
    const r = parseGradeResult(grounded, false);
    expect(r.grounding_score).toBeNull();
    expect(r.grounding_context_used).toBe(false);
    expect(r.unsupported_claims).toEqual([]);
  });

  it('defaults to not-assessed when hasContext omitted entirely', () => {
    const r = parseGradeResult(grounded);
    expect(r.grounding_score).toBeNull();
    expect(r.grounding_context_used).toBe(false);
  });

  it('parses grounding when context was given (hasContext=true)', () => {
    const r = parseGradeResult(grounded, true);
    expect(r.grounding_score).toBe(0.7);
    expect(r.grounding_context_used).toBe(true);
    expect(r.unsupported_claims).toEqual([
      { claim: 'PUT is always edge-cached', reason: 'not in source', severity: 'major' },
    ]);
  });

  it('clamps grounding_score into 0..1', () => {
    expect(parseGradeResult({ grounding_score: 1.8 }, true).grounding_score).toBe(1);
    expect(parseGradeResult({ grounding_score: -0.5 }, true).grounding_score).toBe(0);
  });

  it('null grounding_score when context given but model omits/garbles it', () => {
    expect(parseGradeResult({ score: 'gap' }, true).grounding_score).toBeNull();
    expect(parseGradeResult({ grounding_score: 'high' }, true).grounding_score).toBeNull();
  });

  it('drops malformed unsupported claims and defaults severity to minor', () => {
    const r = parseGradeResult({
      grounding_score: 0.5,
      unsupported_claims: [
        { claim: 'kept', reason: 'r', severity: 'bogus' }, // severity coerced to minor
        { claim: '', reason: 'dropped — empty claim' },     // dropped
        { reason: 'no claim field' },                        // dropped
        'a bare string',                                     // dropped
        { claim: 'major one', severity: 'major' },           // reason defaults to ''
      ],
    }, true);
    expect(r.unsupported_claims).toEqual([
      { claim: 'kept', reason: 'r', severity: 'minor' },
      { claim: 'major one', reason: '', severity: 'major' },
    ]);
  });

  it('ignores grounding fields entirely on the conservative empty-object default', () => {
    const r = parseGradeResult({}, false);
    expect(r.grounding_score).toBeNull();
    expect(r.unsupported_claims).toEqual([]);
  });
});

// ─── Source grounding (gradeResponse wiring) ─────────────────────────────────

describe('gradeResponse — grounding context wiring', () => {
  beforeEach(() => { mockChatJSON.mockReset(); });

  const groundedPayload = JSON.stringify({
    score: 'gap', compression_stage: 1, gaps_detected: ['g'], misconceptions_detected: [],
    grounding_score: 0.4,
    unsupported_claims: [{ claim: 'c', reason: 'r', severity: 'minor' }],
    reasoning: '',
  });
  const usage = { pass: 'grader', provider: 'groq', model: 'llama-test', promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1, retries: 0, cacheReadTokens: 0 } as const;

  it('includes the source context block and assesses grounding when source_context is provided', async () => {
    mockChatJSON.mockResolvedValue({ content: groundedPayload, usage });
    const result = await gradeResponse(config, { ...input, source_context: 'Definition (from source): a ring of keys with minimal remap on membership change.' });
    const [, req] = mockChatJSON.mock.calls[0];
    const userMsg = req.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content).join('\n\n');
    expect(userMsg).toContain('Source context');
    expect(userMsg).toContain('ring of keys');
    expect(result.grounding_context_used).toBe(true);
    expect(result.grounding_score).toBe(0.4);
    expect(result.unsupported_claims).toHaveLength(1);
  });

  it('skips grounding (null) when no source_context is provided', async () => {
    mockChatJSON.mockResolvedValue({ content: groundedPayload, usage });
    const result = await gradeResponse(config, input);
    const [, req] = mockChatJSON.mock.calls[0];
    const userMsg = req.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content).join('\n\n');
    expect(userMsg).not.toContain('Source context');
    expect(result.grounding_context_used).toBe(false);
    expect(result.grounding_score).toBeNull();
    expect(result.unsupported_claims).toEqual([]);
  });

  it('treats a whitespace-only source_context as no context', async () => {
    mockChatJSON.mockResolvedValue({ content: groundedPayload, usage });
    const result = await gradeResponse(config, { ...input, source_context: '   \n  ' });
    expect(result.grounding_context_used).toBe(false);
    expect(result.grounding_score).toBeNull();
  });
});


// ─── Self-consistency + audit (contract 1.3.0) ──────────────────────────────

describe('isBorderlineGrade', () => {
  const base = parseGradeResult({ score: 'recognizes', compression_stage: 2, gaps_detected: ['x'] }, false);
  it('is false for a consistent, ungrounded grade', () => {
    expect(isBorderlineGrade(base)).toBe(false);
  });
  it('flags score/stage disagreement', () => {
    expect(isBorderlineGrade({ ...base, score: 'understood', compression_stage: 2 })).toBe(true);
    expect(isBorderlineGrade({ ...base, score: 'recognizes', compression_stage: 4 })).toBe(true);
  });
  it('flags mid-band grounding only', () => {
    expect(isBorderlineGrade({ ...base, grounding_score: 0.5 })).toBe(true);
    expect(isBorderlineGrade({ ...base, grounding_score: 0.9 })).toBe(false);
  });
});

describe('aggregateGrades', () => {
  const g = (score: string, stage: number, extra: Record<string, unknown> = {}) =>
    parseGradeResult({ score, compression_stage: stage, gaps_detected: [`gap-${score}-${stage}`], ...extra }, 'grounding_score' in extra);

  it('takes the majority score and lower-median stage, with the matching sample text', () => {
    const r = aggregateGrades([g('understood', 3), g('recognizes', 2), g('understood', 4)]);
    expect(r.score).toBe('understood');
    expect(r.compression_stage).toBe(3);
    expect(r.gaps_detected).toEqual(['gap-understood-3']);
  });

  it('breaks ties toward the more conservative score', () => {
    expect(aggregateGrades([g('understood', 3), g('gap', 1)]).score).toBe('gap');
  });

  it('takes the median grounding score when assessed', () => {
    const r = aggregateGrades([
      g('recognizes', 2, { grounding_score: 0.4 }),
      g('recognizes', 2, { grounding_score: 0.9 }),
      g('recognizes', 2, { grounding_score: 0.5 }),
    ]);
    expect(r.grounding_score).toBe(0.5);
  });
});

describe('gradeResponse — self-consistency + audit', () => {
  beforeEach(() => mockChatJSON.mockReset());
  const usage = { pass: 'grader', provider: 'groq' as const, model: 'llama-test', promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1, retries: 0, cacheReadTokens: 0 };
  const out = (o: Record<string, unknown>) => ({ content: JSON.stringify(o), usage });

  it('does not resample a clear grade, and records a 1-sample audit', async () => {
    mockChatJSON.mockResolvedValueOnce(out({ score: 'recognizes', compression_stage: 2, gaps_detected: ['x'] }));
    const r = await gradeResponse(config, input, { selfConsistency: true });
    expect(mockChatJSON).toHaveBeenCalledTimes(1);
    expect(r.audit).toMatchObject({ samples: 1, model: 'groq/llama-test', contract: CONTRACT_VERSION, prompt_hash: GRADER_PROMPT_HASH });
    expect(r.audit.outputs).toHaveLength(1);
  });

  it('resamples a borderline grade twice at higher temperature and aggregates', async () => {
    mockChatJSON
      .mockResolvedValueOnce(out({ score: 'understood', compression_stage: 2, gaps_detected: ['a'] }))
      .mockResolvedValueOnce(out({ score: 'recognizes', compression_stage: 2, gaps_detected: ['b'] }))
      .mockResolvedValueOnce(out({ score: 'recognizes', compression_stage: 2, gaps_detected: ['c'] }));
    const r = await gradeResponse(config, input, { selfConsistency: true });
    expect(mockChatJSON).toHaveBeenCalledTimes(3);
    expect(mockChatJSON.mock.calls[1][2]).toBe('grader:consistency');
    expect(mockChatJSON.mock.calls[1][1].temperature).toBe(0.7);
    expect(r.score).toBe('recognizes');
    expect(r.audit.samples).toBe(3);
  });

  it('never resamples when self-consistency is off', async () => {
    mockChatJSON.mockResolvedValueOnce(out({ score: 'understood', compression_stage: 2, gaps_detected: ['a'] }));
    await gradeResponse(config, input);
    expect(mockChatJSON).toHaveBeenCalledTimes(1);
  });

  it('keeps the first grade when an extra sample fails', async () => {
    mockChatJSON
      .mockResolvedValueOnce(out({ score: 'understood', compression_stage: 2, gaps_detected: ['a'] }))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce(out({ score: 'understood', compression_stage: 3, gaps_detected: ['b'] }));
    const r = await gradeResponse(config, input, { selfConsistency: true });
    expect(r.audit.samples).toBe(2);
    expect(r.score).toBe('understood');
  });

  it('puts calibration examples in the system prompt', async () => {
    mockChatJSON.mockResolvedValueOnce(out({ score: 'gap', compression_stage: 1, gaps_detected: ['x'] }));
    await gradeResponse(config, input);
    const sys = mockChatJSON.mock.calls[0][1].messages[0].content as string;
    expect(sys).toContain('CALIBRATION EXAMPLES');
  });
});

describe('GraderOutputSchema leniency', () => {
  it('wraps a lone string list field but still rejects a bad score', () => {
    const ok = GraderOutputSchema.parse({ score: 'gap', compression_stage: 1, misconceptions_detected: 'confuses sunk cost', gaps_detected: '' });
    expect(ok.misconceptions_detected).toEqual(['confuses sunk cost']);
    expect(ok.gaps_detected).toEqual([]);
    expect(GraderOutputSchema.safeParse({ score: 'great', compression_stage: 1 }).success).toBe(false);
  });
});
