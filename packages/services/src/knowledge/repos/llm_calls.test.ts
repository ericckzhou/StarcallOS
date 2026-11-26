import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import type { LlmTraceEvent } from '../../core/llm';
import { createLlmCallSink, insertLlmCall, summarizeLlmCalls } from './llm_calls';

const ev = (over: Partial<LlmTraceEvent> = {}): LlmTraceEvent => ({
  pass: 'grader', provider: 'groq', model: 'm', status: 'ok', errorMessage: null,
  promptTokens: 100, completionTokens: 20, cacheReadTokens: 0,
  durationMs: 500, retries: 0, promptHash: 'abc', ...over,
});

describe('llm_calls', () => {
  it('aggregates per pass with errors, retries and p95', () => {
    const db = openDb(':memory:');
    const sink = createLlmCallSink(db);
    for (let i = 1; i <= 20; i++) sink(ev({ durationMs: i * 100 }));
    insertLlmCall(db, ev({ status: 'error', errorMessage: 'x'.repeat(900), retries: 3, promptTokens: 0, completionTokens: 0 }));
    insertLlmCall(db, ev({ pass: 'lazy_tasks', cacheReadTokens: 50 }));

    const s = summarizeLlmCalls(db, 30);
    expect(s.total_calls).toBe(22);
    expect(s.total_errors).toBe(1);
    const grader = s.by_pass.find(p => p.pass === 'grader')!;
    expect(grader.calls).toBe(21);
    expect(grader.errors).toBe(1);
    expect(grader.retries).toBe(3);
    expect(grader.prompt_tokens).toBe(2000);
    expect(grader.p95_duration_ms).toBe(1900);
    expect(s.by_pass[0].pass).toBe('grader');
    expect(s.by_pass.find(p => p.pass === 'lazy_tasks')!.cache_read_tokens).toBe(50);

    const msg = db.prepare("SELECT error_message FROM llm_calls WHERE status='error'").get() as { error_message: string };
    expect(msg.error_message.length).toBe(500);
  });

  it('returns an empty summary for a fresh DB', () => {
    const db = openDb(':memory:');
    expect(summarizeLlmCalls(db).total_calls).toBe(0);
  });
});
