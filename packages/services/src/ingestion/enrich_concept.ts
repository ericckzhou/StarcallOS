// On-demand definition enrichment for a single concept.
// One LLM call. Fills in definition_text / why_exists / what_breaks /
// where_reappears on a promoted concept that was created from a deterministic
// candidate (and thus has empty narrative fields).
//
// Cost: ~$0.005 on Haiku, ~$0.02 on Sonnet. Pay-per-concept.

import { chatJSON, type ProviderConfig } from '../core/llm';
import type { DatabaseSync } from '../core/infra/sqlite';
import { getConceptById } from '../knowledge/repos/concepts';
import { getSourceById } from '../knowledge/repos/sources';
import type { Concept } from '../core/domain/types';

const ENRICH_SYSTEM = `You are an expert tutor across all academic and professional domains
(STEM, humanities, social sciences, law, medicine, business, trades, etc.).
You receive a concept name plus the source it was extracted from (book/article
title, section path, and verbatim quotes from surrounding pages). Your job is
to write production-quality knowledge entries that match THIS source's meaning
of the term — in the same domain, with the same definitions and conventions.

CRITICAL — disambiguate by source, never by your default association:
Many concept names are ambiguous across domains. Examples:
  • "RAG" — Retrieval-Augmented Generation (AI) vs. Red/Amber/Green status (project management)
  • "Mole" — small mammal (zoology) vs. unit of substance (chemistry) vs. skin lesion (medicine) vs. spy (intelligence)
  • "Force" — push/pull (physics) vs. workforce (HR) vs. military (defense)
  • "Class" — taxonomic rank (biology) vs. type of object (programming) vs. social stratum (sociology) vs. course session (education)
Always pick the meaning the SOURCE TITLE, SECTION, and EVIDENCE point to.
Never default to a meaning that contradicts the surrounding context. If the
source plainly indicates one domain, use that domain's vocabulary, examples,
and adjacent concepts in every field of your output.

Be concrete, precise, and short. No marketing language. No hedging.
If the provided context is insufficient to disambiguate, say so explicitly in
definition_text ("not enough context to define") and leave other fields empty.

EXAMPLE (format reference only — the example happens to be from ML; your
output must reflect the ACTUAL domain of the supplied concept and source)
Concept name: Backpropagation
Source title: Deep Learning
Section: Chapter 6 › 6.5 Back-Propagation and Other Differentiation Algorithms
Evidence: "Backpropagation refers only to the method for computing the gradient,
  while another algorithm, such as stochastic gradient descent, is used to
  perform learning using this gradient."

Output:
{
  "definition_text": "Backpropagation is the algorithm for computing the gradient of a scalar loss with respect to each weight in a neural network by applying the chain rule backward through the computation graph, reusing intermediate activations stored during the forward pass.",
  "why_exists": "It lets gradient-based optimizers train deep networks in time proportional to the forward pass, rather than the exponential cost of naive per-weight derivatives.",
  "what_breaks": "Without it, training reduces to expensive numerical differentiation or finite differences; with stale or missing forward activations, gradients become wrong and learning silently diverges.",
  "where_reappears": ["Gradient Descent", "Chain Rule", "Computation Graph", "Vanishing Gradient", "Automatic Differentiation"]
}

Respond ONLY with JSON in this exact shape:
{
  "definition_text": "1–3 sentences. The precise meaning AS USED IN THIS SOURCE.",
  "why_exists": "1–2 sentences. The problem this concept solves in its domain.",
  "what_breaks": "1–2 sentences. What goes wrong when this is missing or misapplied.",
  "where_reappears": ["other concept names from the SAME domain where this matters", "max 5"]
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

  const source = getSourceById(db, concept.source_id);

  const context: string[] = [`Concept name: ${concept.name}`];
  if (source?.title) {
    context.push(`Source title: ${source.title}`);
  } else if (source?.filename) {
    context.push(`Source filename: ${source.filename}`);
  }
  if (source?.author) {
    context.push(`Author: ${source.author}`);
  }
  if (concept.section_path.length > 0) {
    context.push(`Section: ${concept.section_path.join(' › ')}`);
  }
  // Intentionally do NOT pass the prior definition_text as a "fragment".
  // For ambiguous concepts (e.g. "RAG"), if the LLM was wrong last run, that
  // wrong text becomes a strong anchor that drags this run in the same wrong
  // direction. Source title + section + verbatim source quotes are enough.

  // Gather verbatim quotes that prove the concept's actual domain. The
  // priority order: (1) concept.evidence_json (snapshot from promotion),
  // (2) the matching concept_candidates row's evidence column,
  // (3) up to 3 semantic_chunks for this source matching the concept name.
  const quotes = collectQuotes(db, concept.id, concept.source_id, concept.name);
  if (quotes.length > 0) {
    context.push('Verbatim quotes from THIS source (use these to disambiguate the meaning):');
    for (const q of quotes) context.push(`  • ${q}`);
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

// Pulls up to 5 distinct evidence quotes anchoring the concept to its actual
// domain. Falls through tiers in priority order so an unbackfilled concept
// (no evidence_json) still gets quotes the model can disambiguate against.
function collectQuotes(
  db: DatabaseSync,
  conceptId: number,
  sourceId: number,
  conceptName: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const MAX = 5;
  const push = (quote: string, page?: number | null) => {
    const q = quote.trim();
    if (!q) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const truncated = q.length > 320 ? q.slice(0, 320) + '…' : q;
    out.push(page != null ? `(p.${page}) ${truncated}` : truncated);
  };

  // Tier 1: concept.evidence_json (snapshotted on promotion)
  try {
    const row = db
      .prepare('SELECT evidence_json FROM concepts WHERE id = ?')
      .get(conceptId) as { evidence_json?: string } | undefined;
    if (row?.evidence_json) {
      const spans = JSON.parse(row.evidence_json) as Array<{ quote?: string; page?: number }>;
      for (const s of spans) {
        if (out.length >= MAX) break;
        if (s.quote) push(s.quote, s.page);
      }
    }
  } catch { /* fall through */ }

  // Tier 2: concept_candidates.evidence for the matching candidate row.
  // Every promoted concept came from a candidate, so this is reliable.
  if (out.length < MAX) {
    try {
      const normalized = conceptName.toLowerCase().replace(/\s+/g, ' ').trim();
      const cand = db
        .prepare(
          `SELECT evidence FROM concept_candidates
            WHERE source_id = ? AND lower(normalized) = ?
            LIMIT 1`,
        )
        .get(sourceId, normalized) as { evidence?: string } | undefined;
      if (cand?.evidence) {
        const spans = JSON.parse(cand.evidence) as Array<{ quote?: string; page?: number }>;
        for (const s of spans) {
          if (out.length >= MAX) break;
          if (s.quote) push(s.quote, s.page);
        }
      }
    } catch { /* fall through */ }
  }

  // Tier 3: semantic_chunks on the same source that mention the concept name.
  // Only present in candidate_gated / full modes; harmless when empty.
  if (out.length < MAX) {
    try {
      const like = `%${conceptName.toLowerCase()}%`;
      const chunks = db
        .prepare(
          `SELECT content, page_start FROM semantic_chunks
            WHERE source_id = ? AND lower(content) LIKE ?
            ORDER BY page_start
            LIMIT ?`,
        )
        .all(sourceId, like, MAX - out.length) as Array<{ content: string; page_start: number }>;
      for (const c of chunks) {
        if (out.length >= MAX) break;
        push(c.content, c.page_start);
      }
    } catch { /* fall through */ }
  }

  return out;
}
