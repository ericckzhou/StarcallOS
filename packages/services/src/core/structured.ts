import { z } from 'zod';
import { chatJSON, type ChatRequest, type ProviderConfig, type UsageStats } from './llm';

// ─── Structured output: validate → repair once → typed error ─────────────────

export class LlmParseError extends Error {
  constructor(
    public readonly passName: string,
    public readonly issues: string,
    public readonly rawContent: string,
  ) {
    super(`LLM output for pass "${passName}" failed validation after one repair attempt: ${issues}`);
    this.name = 'LlmParseError';
  }
}

export interface StructuredOptions<T> {
  schema: z.ZodType<T>;
  // Tool/schema name sent to providers with native enforcement ([a-zA-Z0-9_-]).
  name: string;
  description?: string;
}

function describeFailure(content: string, schema: z.ZodType<unknown>): { ok: true; data: unknown } | { ok: false; issues: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { ok: false, issues: `invalid JSON (${(e as Error).message})` };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const issues = r.error.issues.slice(0, 8)
    .map(i => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, issues };
}

// JSON Schema for a Zod schema, as a provider tool input_schema. `io: 'input'`
// keeps fields with defaults optional, matching what the model may omit.
export function toProviderJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

// Typed structured call. One chatJSON call (with native schema enforcement on
// Anthropic); if the output is not valid JSON or fails the Zod schema, ONE
// repair call is made that shows the model its own output plus the validation
// errors. The repair call is traced under `<pass>:repair`, so the Settings usage
// table doubles as a per-pass repair-rate monitor. Still invalid → LlmParseError
// (callers must not silently substitute a default result).
export async function chatStructured<T>(
  config: ProviderConfig,
  req: ChatRequest,
  passName: string,
  opts: StructuredOptions<T>,
): Promise<{ data: T; usage: UsageStats; repaired: boolean }> {
  const jsonSchema = {
    name: opts.name,
    description: opts.description,
    schema: toProviderJsonSchema(opts.schema as z.ZodType<unknown>),
  };
  const first = await chatJSON(config, { ...req, responseFormat: 'json', jsonSchema }, passName);
  const v1 = describeFailure(first.content, opts.schema as z.ZodType<unknown>);
  if (v1.ok) return { data: v1.data as T, usage: first.usage, repaired: false };

  console.warn(`[LLM] pass=${passName} output failed validation, attempting repair: ${v1.issues}`);
  const repair = await chatJSON(
    config,
    {
      ...req,
      responseFormat: 'json',
      jsonSchema,
      temperature: 0,
      messages: [
        ...req.messages,
        { role: 'assistant', content: first.content.slice(0, 6000) || '(empty)' },
        {
          role: 'user',
          content:
            `Your previous output was rejected: ${v1.issues}\n` +
            'Return the corrected result as valid JSON only, with exactly the required fields and allowed values. Do not add commentary.',
        },
      ],
    },
    `${passName}:repair`,
  );
  const v2 = describeFailure(repair.content, opts.schema as z.ZodType<unknown>);
  if (v2.ok) return { data: v2.data as T, usage: repair.usage, repaired: true };
  throw new LlmParseError(passName, v2.issues, repair.content.slice(0, 2000));
}
