// Append-only persistence for the chatJSON trace (migration 0031).
// Main installs `createLlmCallSink(db)` via setLlmTraceSink at startup.

import type { DatabaseSync } from '../../core/infra/sqlite';
import type { LlmTraceEvent, LlmTraceSink } from '../../core/llm';

export function insertLlmCall(db: DatabaseSync, e: LlmTraceEvent): void {
  db.prepare(`
    INSERT INTO llm_calls
      (pass, provider, model, status, error_message, prompt_tokens,
       completion_tokens, cache_read_tokens, duration_ms, retries, prompt_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.pass, e.provider, e.model, e.status, e.errorMessage?.slice(0, 500) ?? null,
    e.promptTokens, e.completionTokens, e.cacheReadTokens,
    Math.round(e.durationMs), e.retries, e.promptHash,
  );
}

export function createLlmCallSink(db: DatabaseSync): LlmTraceSink {
  return (e) => insertLlmCall(db, e);
}

export interface LlmPassSummary {
  pass: string;
  calls: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  retries: number;
}

export interface LlmTraceSummary {
  days: number;
  total_calls: number;
  total_errors: number;
  total_tokens: number;
  by_pass: LlmPassSummary[];
}

// Per-pass aggregates over the last `days` days. p95 is computed in TS over the
// pass's durations (SQLite has no percentile function); volumes here are small.
export function summarizeLlmCalls(db: DatabaseSync, days = 30): LlmTraceSummary {
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const rows = db.prepare(`
    SELECT pass, status, prompt_tokens, completion_tokens, cache_read_tokens,
           duration_ms, retries
      FROM llm_calls
     WHERE created_at >= datetime('now', ?)
  `).all(since) as Array<{
    pass: string; status: string; prompt_tokens: number; completion_tokens: number;
    cache_read_tokens: number; duration_ms: number; retries: number;
  }>;

  const byPass = new Map<string, { s: LlmPassSummary; durations: number[] }>();
  for (const r of rows) {
    let b = byPass.get(r.pass);
    if (!b) {
      b = {
        s: {
          pass: r.pass, calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0,
          cache_read_tokens: 0, avg_duration_ms: 0, p95_duration_ms: 0, retries: 0,
        },
        durations: [],
      };
      byPass.set(r.pass, b);
    }
    b.s.calls += 1;
    if (r.status === 'error') b.s.errors += 1;
    b.s.prompt_tokens += r.prompt_tokens;
    b.s.completion_tokens += r.completion_tokens;
    b.s.cache_read_tokens += r.cache_read_tokens;
    b.s.retries += r.retries;
    b.durations.push(r.duration_ms);
  }

  const by_pass = [...byPass.values()].map(({ s, durations }) => {
    durations.sort((a, b) => a - b);
    s.avg_duration_ms = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    s.p95_duration_ms = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)];
    return s;
  }).sort((a, b) => b.calls - a.calls);

  return {
    days,
    total_calls: rows.length,
    total_errors: by_pass.reduce((a, p) => a + p.errors, 0),
    total_tokens: by_pass.reduce((a, p) => a + p.prompt_tokens + p.completion_tokens, 0),
    by_pass,
  };
}
