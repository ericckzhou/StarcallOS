import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

// ─── Provider config ──────────────────────────────────────────────────────────

export type ProviderId = 'groq' | 'anthropic' | 'local';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  // 'local' only: OpenAI-compatible base URL (Ollama, llama.cpp server, LM Studio).
  baseUrl?: string;
}

// ─── Local OpenAI-compatible provider ────────────────────────────────────────

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';
// Local models on CPU can be slow; generous but bounded.
export const LOCAL_TIMEOUT_MS = 180_000;

// http(s) only, no credentials, trailing slash stripped. Returns null when the
// value is not a usable base URL. Any host is allowed (a LAN GPU box is a
// legitimate target): this is the user's own setting, not untrusted input, and
// it is unrelated to the URL importer's SSRF guard.
export function normalizeLocalBaseUrl(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.toString().replace(/\/+$/, '');
}

function localUnreachable(baseUrl: string, e: unknown): Error {
  const cause = (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.name ?? '';
  const why = cause === 'TimeoutError' ? 'timed out' : 'could not be reached';
  return new Error(`Local model server at ${baseUrl} ${why}. Is it running (e.g. \`ollama serve\`)?`);
}

// Lists model ids from GET {baseUrl}/models (OpenAI-compatible).
export async function listLocalModels(baseUrlRaw: string): Promise<string[]> {
  const baseUrl = normalizeLocalBaseUrl(baseUrlRaw);
  if (!baseUrl) throw new Error('Base URL must be an http(s) URL.');
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    throw localUnreachable(baseUrl, e);
  }
  if (!res.ok) throw new Error(`Local model server returned HTTP ${res.status} for /models.`);
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
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
  // Provider-level retries performed before the call succeeded (Groq loop).
  retries: number;
  // Anthropic prompt-cache read tokens (0 when caching is unused/unsupported).
  cacheReadTokens: number;
}

// ─── Persistent call trace ────────────────────────────────────────────────────
// chatJSON emits one LlmTraceEvent per call (success OR failure) to an optional
// sink. Services stay DB-free: Electron main installs a sink that appends to the
// `llm_calls` table. Sink errors are swallowed — tracing must never break a call.

export interface LlmTraceEvent {
  pass: string;
  provider: ProviderId;
  model: string;
  status: 'ok' | 'error';
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  retries: number;
  // sha256 (first 16 hex) of the system prompt(s): identifies the prompt
  // version that produced a result without storing the prompt text.
  promptHash: string;
}

export type LlmTraceSink = (event: LlmTraceEvent) => void;

let traceSink: LlmTraceSink | null = null;

export function setLlmTraceSink(sink: LlmTraceSink | null): void {
  traceSink = sink;
}

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function emitTrace(event: LlmTraceEvent): void {
  if (!traceSink) return;
  try { traceSink(event); } catch (e) {
    console.warn('[LLM] trace sink failed:', (e as Error).message);
  }
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
  // Anthropic prompt caching: mark a STABLE prefix block (system prompt,
  // per-concept source context) as a cache breakpoint. Everything up to and
  // including the last marked block is cached for ~5 min. Order matters: put
  // cacheable messages before per-call content. Ignored by Groq. Anthropic
  // only caches prefixes above a model-specific minimum (~1-4K tokens);
  // shorter prefixes are silently not cached.
  cache?: boolean;
}

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

// Pure mapping from the provider-neutral request to Anthropic's system +
// messages. Consecutive same-role messages are merged into one message of text
// blocks (Anthropic requires alternating roles); `cache` marks become
// cache_control breakpoints (max 4 per request — extra marks are dropped from
// the front so the longest prefixes win).
export function toAnthropicPayload(req: ChatRequest, jsonSuffix: string | null): {
  system: string | AnthropicTextBlock[] | undefined;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicTextBlock[] }>;
} {
  const sysMsgs = req.messages.filter(m => m.role === 'system');
  let sysText = sysMsgs.map(m => m.content).join('\n\n');
  if (jsonSuffix) sysText = sysText ? `${sysText}\n\n${jsonSuffix}` : jsonSuffix;
  const sysCached = sysMsgs.some(m => m.cache);

  const grouped: Array<{ role: 'user' | 'assistant'; blocks: AnthropicTextBlock[]; plain: boolean }> = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const block: AnthropicTextBlock = { type: 'text', text: m.content };
    if (m.cache) block.cache_control = { type: 'ephemeral' };
    const last = grouped[grouped.length - 1];
    if (last && last.role === role) { last.blocks.push(block); last.plain = false; }
    else grouped.push({ role, blocks: [block], plain: !m.cache });
  }

  // Enforce the 4-breakpoint limit, keeping the LAST (longest-prefix) marks.
  const marked: AnthropicTextBlock[] = grouped.flatMap(g => g.blocks.filter(b => b.cache_control));
  const budget = 4 - (sysCached && sysText ? 1 : 0);
  for (const b of marked.slice(0, Math.max(0, marked.length - budget))) delete b.cache_control;

  return {
    system: !sysText ? undefined
      : sysCached ? [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }]
      : sysText,
    messages: grouped.map(g => ({
      role: g.role,
      content: g.plain && g.blocks.length === 1 ? g.blocks[0].text : g.blocks,
    })),
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  responseFormat?: 'json' | 'text';
  temperature?: number;
  maxTokens?: number;
  // Native schema enforcement where the provider supports it. Anthropic: the
  // call is made as a single forced tool whose input_schema is this schema, and
  // `content` is the tool input re-serialized as JSON. Groq: ignored (the
  // curated llama models only support json_object mode) — chatStructured's
  // validate→repair loop covers it instead.
  jsonSchema?: { name: string; description?: string; schema: Record<string, unknown> };
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
  let cacheReadTokens = 0;
  let retries = 0;
  let content = '';
  const promptHash = hashPrompt(
    req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
  );

  try {
    if (config.provider === 'local') {
      const baseUrl = normalizeLocalBaseUrl(config.baseUrl) ?? DEFAULT_LOCAL_BASE_URL;
      // Thinking models (qwen3.x, deepseek-r1, gpt-oss) otherwise spend the whole
      // max_tokens budget on hidden reasoning and return truncated or empty JSON.
      // reasoning_effort "none" disables that on Ollama; a server that rejects
      // the field with a 400 is retried once without it.
      const post = (disableReasoning: boolean) => fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages.map(m => ({ role: m.role, content: m.content })),
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 4096,
          stream: false,
          ...(disableReasoning ? { reasoning_effort: 'none' } : {}),
          ...(req.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });
      let res: Response;
      try {
        res = await post(true);
        if (res.status === 400) {
          const detail = await res.clone().text().catch(() => '');
          if (/reasoning/i.test(detail)) { retries += 1; res = await post(false); }
        }
      } catch (e) {
        throw Object.assign(localUnreachable(baseUrl, e), { passName, provider: 'local', llmModel: config.model });
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw Object.assign(
          new Error(`Local model server HTTP ${res.status}${detail ? `: ${detail}` : ''}`),
          { passName, provider: 'local', llmModel: config.model, status: res.status },
        );
      }
      const body = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      promptTokens = body.usage?.prompt_tokens ?? 0;
      completionTokens = body.usage?.completion_tokens ?? 0;
      totalTokens = body.usage?.total_tokens ?? promptTokens + completionTokens;
      content = body.choices?.[0]?.message?.content ?? '';
      if (req.responseFormat === 'json') content = stripJsonFences(content);
    } else if (config.provider === 'groq') {
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
      // Retry on 429 (TPM/RPM), 502/503/504 (transient server errors).
      // 429 respects Retry-After; others use exponential backoff.
      const GROQ_RETRYABLE = new Set([429, 502, 503, 504]);
      let response: Awaited<ReturnType<typeof callGroq>>;
      for (let attempt = 0; ; attempt++) {
        try { response = await callGroq(); break; }
        catch (e) {
          const status = (e as { status?: number }).status;
          if (!status || !GROQ_RETRYABLE.has(status) || attempt >= 4) {
            throw Object.assign(e as Error, { passName, provider: 'groq', llmModel: config.model });
          }
          retries = attempt + 1;
          const ra = status === 429
            ? Number((e as { headers?: Record<string, string> }).headers?.['retry-after'])
            : NaN;
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
      // Anthropic does not have native JSON mode — request it via system prompt
      // augmentation (or, with jsonSchema, a forced tool). The shape contract is
      // identical so callers stay unchanged.
      const payload = toAnthropicPayload(
        req,
        req.responseFormat === 'json' ? 'IMPORTANT: Respond with valid JSON only. No prose, no markdown fences, no preamble.' : null,
      );

      // Anthropic SDK retries 429/500/502/503/529 automatically (2 attempts).
      let response: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        response = await client.messages.create({
          model: config.model,
          system: payload.system,
          messages: payload.messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 8192,
          ...(req.jsonSchema ? {
            tools: [{
              name: req.jsonSchema.name,
              description: req.jsonSchema.description ?? 'Return the result in this exact structure.',
              input_schema: req.jsonSchema.schema as Anthropic.Messages.Tool.InputSchema,
            }],
            tool_choice: { type: 'tool' as const, name: req.jsonSchema.name },
          } : {}),
        });
      } catch (e) {
        throw Object.assign(e as Error, { passName, provider: 'anthropic', llmModel: config.model });
      }
      promptTokens = response.usage.input_tokens;
      completionTokens = response.usage.output_tokens;
      cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
      totalTokens = promptTokens + completionTokens;
      const toolBlock = req.jsonSchema ? response.content.find(b => b.type === 'tool_use') : undefined;
      if (toolBlock && toolBlock.type === 'tool_use') {
        content = JSON.stringify(toolBlock.input ?? {});
      } else {
        const block = response.content.find(b => b.type === 'text');
        content = block && block.type === 'text' ? block.text : '';
      }
      // Strip markdown fences Claude sometimes wraps JSON in despite the instruction
      if (req.responseFormat === 'json') {
        content = stripJsonFences(content);
      }
    }
  } catch (e) {
    emitTrace({
      pass: passName, provider: config.provider, model: config.model,
      status: 'error', errorMessage: (e as Error)?.message ?? String(e),
      promptTokens: 0, completionTokens: 0, cacheReadTokens: 0,
      durationMs: Date.now() - start, retries, promptHash,
    });
    throw e;
  }

  const durationMs = Date.now() - start;
  const usage: UsageStats = {
    pass: passName,
    provider: config.provider,
    model: config.model,
    promptTokens, completionTokens, totalTokens, durationMs,
    retries, cacheReadTokens,
  };

  console.log(
    `[LLM] pass=${usage.pass} provider=${usage.provider} model=${usage.model} prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens} dur=${usage.durationMs}ms`,
  );
  recordUsage(usage);
  emitTrace({
    pass: passName, provider: config.provider, model: config.model,
    status: 'ok', errorMessage: null,
    promptTokens, completionTokens, cacheReadTokens, durationMs, retries, promptHash,
  });

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
  // Placeholder only: the local model is a free-text setting (localModel).
  local:     { heavy: 'llama3.1:8b',               light: 'llama3.1:8b' },
};
