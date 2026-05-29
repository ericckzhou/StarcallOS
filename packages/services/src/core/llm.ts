import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';

// ─── Provider config ──────────────────────────────────────────────────────────

export type ProviderId = 'groq' | 'anthropic';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
}

// ─── Usage instrumentation ────────────────────────────────────────────────────

export interface UsageStats {
  pass: string;
  provider: ProviderId;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface PassTotals {
  total: number;
  calls: number;
  prompt: number;
  completion: number;
}

export interface UsageSnapshot {
  byPass: Record<string, PassTotals>;
  total: number;
  calls: number;
}

let accumulator: UsageSnapshot = { byPass: {}, total: 0, calls: 0 };

export function resetUsageStats(): void {
  accumulator = { byPass: {}, total: 0, calls: 0 };
}

export function getUsageStats(): UsageSnapshot {
  return {
    byPass: Object.fromEntries(
      Object.entries(accumulator.byPass).map(([k, v]) => [k, { ...v }]),
    ),
    total: accumulator.total,
    calls: accumulator.calls,
  };
}

function recordUsage(stats: UsageStats): void {
  const bucket = accumulator.byPass[stats.pass] ?? {
    total: 0, calls: 0, prompt: 0, completion: 0,
  };
  bucket.total += stats.totalTokens;
  bucket.calls += 1;
  bucket.prompt += stats.promptTokens;
  bucket.completion += stats.completionTokens;
  accumulator.byPass[stats.pass] = bucket;
  accumulator.total += stats.totalTokens;
  accumulator.calls += 1;
}

// ─── Common request shape ─────────────────────────────────────────────────────
// A provider-neutral chat request. The wrapper translates this to whichever
// SDK is selected. Keeps call sites identical across providers.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  responseFormat?: 'json' | 'text';
  temperature?: number;
  maxTokens?: number;
}

// ─── Single chokepoint ────────────────────────────────────────────────────────

export async function chatJSON(
  config: ProviderConfig,
  req: ChatRequest,
  passName: string,
): Promise<{ content: string; usage: UsageStats }> {
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let content = '';

  if (config.provider === 'groq') {
    // Free-tier Groq TPM includes the max_tokens reservation. Hard cap at 4096
    // so requests stay under the 6K TPM cap on llama-3.1-8b-instant. Heavier
    // tiers can override per-pass via req.maxTokens, capped here at 8192.
    const groqMaxTokensCap = 4096;
    const cappedMaxTokens = Math.min(req.maxTokens ?? groqMaxTokensCap, groqMaxTokensCap);
    const client = new Groq({ apiKey: config.apiKey });
    const callGroq = () => client.chat.completions.create({
      model: config.model,
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      response_format: req.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      temperature: req.temperature ?? 0.2,
      max_tokens: cappedMaxTokens,
    });
    // Retry on 429 (free-tier TPM/RPM) with backoff — respects Retry-After when
    // present, else exponential. Lets paced multi-batch passes ride out limits.
    let response: Awaited<ReturnType<typeof callGroq>>;
    for (let attempt = 0; ; attempt++) {
      try { response = await callGroq(); break; }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status !== 429 || attempt >= 4) throw e;
        const ra = Number((e as { headers?: Record<string, string> }).headers?.['retry-after']);
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(15000, ra * 1000) : Math.min(8000, 500 * 2 ** attempt);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    const u = (response.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    promptTokens = u.prompt_tokens ?? 0;
    completionTokens = u.completion_tokens ?? 0;
    totalTokens = u.total_tokens ?? promptTokens + completionTokens;
    content = response.choices?.[0]?.message?.content ?? '';
  } else {
    const client = new Anthropic({ apiKey: config.apiKey });
    const sys = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const userMsgs = req.messages.filter(m => m.role !== 'system');
    // Anthropic does not have native JSON mode — request it via system prompt
    // augmentation. The shape contract is identical so callers stay unchanged.
    const sysWithJson = req.responseFormat === 'json'
      ? `${sys}\n\nIMPORTANT: Respond with valid JSON only. No prose, no markdown fences, no preamble.`
      : sys;

    const response = await client.messages.create({
      model: config.model,
      system: sysWithJson || undefined,
      messages: userMsgs.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 8192,
    });
    promptTokens = response.usage.input_tokens;
    completionTokens = response.usage.output_tokens;
    totalTokens = promptTokens + completionTokens;
    const block = response.content.find(b => b.type === 'text');
    content = block && block.type === 'text' ? block.text : '';
    // Strip markdown fences Claude sometimes wraps JSON in despite the instruction
    if (req.responseFormat === 'json') {
      content = stripJsonFences(content);
    }
  }

  const durationMs = Date.now() - start;
  const usage: UsageStats = {
    pass: passName,
    provider: config.provider,
    model: config.model,
    promptTokens, completionTokens, totalTokens, durationMs,
  };

  console.log(
    `[LLM] pass=${usage.pass} provider=${usage.provider} model=${usage.model} prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens} dur=${usage.durationMs}ms`,
  );
  recordUsage(usage);

  return { content, usage };
}

function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_MODELS: Record<ProviderId, { heavy: string; light: string }> = {
  groq:      { heavy: 'llama-3.3-70b-versatile',   light: 'llama-3.1-8b-instant' },
  anthropic: { heavy: 'claude-sonnet-4-6',         light: 'claude-haiku-4-5-20251001' },
};
