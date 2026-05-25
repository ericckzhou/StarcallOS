// On-demand definition enrichment for a single concept.
// One LLM call. Fills in definition_text / why_exists / what_breaks /
// where_reappears on a promoted concept that was created from a deterministic
// candidate (and thus has empty narrative fields).
//
// Cost: ~$0.005 on Haiku, ~$0.02 on Sonnet. Pay-per-concept.

import { chatJSON, type ProviderConfig } from '../core/llm';
import type { DatabaseSync } from '../core/infra/sqlite';
import { getConceptById } from '../knowledge/repos/concepts';
import type { Concept } from '../core/domain/types';

const ENRICH_SYSTEM = `You are an expert in ML, AI, and computer science.
Given a single concept's name (and any partial context you have), write
production-quality knowledge entries.

Be concrete, technical, and short. No marketing language. No hedging.
If you do not know the concept, say so explicitly in definition_text
("not enough context to define") and leave other fields as empty strings.

Respond ONLY with JSON in this exact shape:
{
  "definition_text": "1–3 sentences. The precise technical meaning.",
  "why_exists": "1–2 sentences. The problem this concept solves.",
  "what_breaks": "1–2 sentences. What goes wrong when this is missing or misapplied.",
  "where_reappears": ["other concept names where this matters", "max 5"]
}`;

interface EnrichedFields {
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string[];
}

export async function enrichConceptDefinition(
  config: ProviderConfig,
  db: DatabaseSync,
  conceptId: number,
): Promise<Concept> {
  const concept = getConceptById(db, conceptId);
  if (!concept) throw new Error(`concept ${conceptId} not found`);

  const context: string[] = [`Concept name: ${concept.name}`];
  if (concept.section_path.length > 0) {
    context.push(`Section: ${concept.section_path.join(' › ')}`);
  }
  if (concept.definition_text && concept.definition_text !== concept.name) {
    context.push(`Existing definition fragment (verbatim from source): ${concept.definition_text}`);
  }

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: ENRICH_SYSTEM },
        { role: 'user', content: context.join('\n') },
      ],
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1024,
    },
    'enrich_concept',
  );

  let parsed: Partial<EnrichedFields>;
  try {
    parsed = JSON.parse(content || '{}');
  } catch {
    throw new Error('enrich_concept returned invalid JSON');
  }

  const definition_text = (parsed.definition_text ?? '').trim();
  const why_exists      = (parsed.why_exists      ?? '').trim();
  const what_breaks     = (parsed.what_breaks     ?? '').trim();
  const where_reappears = Array.isArray(parsed.where_reappears)
    ? parsed.where_reappears.slice(0, 5).map(s => String(s).trim()).filter(Boolean)
    : [];

  db.prepare(
    `UPDATE concepts
     SET definition_text = ?, why_exists = ?, what_breaks = ?, where_reappears = ?
     WHERE id = ?`,
  ).run(
    definition_text,
    why_exists,
    what_breaks,
    JSON.stringify(where_reappears),
    conceptId,
  );

  return getConceptById(db, conceptId)!;
}
