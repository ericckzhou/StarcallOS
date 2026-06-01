import type { SegmentedBlock } from './layout';
import type { BlockType, SectionNode } from '../core/domain/types';
import type { ExtractedChunk } from './extraction';
import { chatJSON, type ProviderConfig } from '../core/llm';

// ─── Enrichment prompt ────────────────────────────────────────────────────────
// The geometry layer already determined block boundaries, reading order,
// and a hint. The LLM's only job here is semantic interpretation.

const ENRICH_SYSTEM = `You are a semantic interpreter for pre-segmented document blocks.
The document has already been parsed geometrically. Block boundaries, reading order,
and layout hints are correct — do NOT alter them.

For each block, output:
- block_type: one of definition|theorem|mechanism|example|derivation|claim|evidence|
  warning|formula|procedure|comparison|assumption|transition|misconception_zone
  Use the geometry hint as a strong prior. Override only when the content clearly
  contradicts it (e.g., hint=heading but content is a full definition paragraph).
- claim: the single core assertion this block makes, or null
- assumptions: list of stated or implied prerequisites (empty array if none)
- example_quote: best verbatim sentence that exemplifies the block's point, or null

Respond ONLY with JSON: { "enriched": [...] }
Each item: { "idx": N, "block_type": "...", "claim": "..."|null, "assumptions": [...], "example_quote": "..."|null }`;

// Allowed block types (mirrors the SQL CHECK constraint on semantic_chunks).
const VALID_BLOCK_TYPES = new Set<string>([
  'definition', 'theorem', 'mechanism', 'example', 'derivation',
  'misconception_zone', 'assumption', 'transition',
  'claim', 'evidence', 'warning', 'formula', 'procedure', 'comparison',
]);

// Hint → block_type prior fed to the LLM so it doesn't re-derive from scratch
const HINT_TO_PRIOR: Record<string, string> = {
  heading:    'transition',
  subheading: 'transition',
  body:       'mechanism',
  formula:    'formula',
  list_item:  'procedure',
  caption:    'transition',
  footnote:   'assumption',
  unknown:    'mechanism',
};

// ─── Batching ─────────────────────────────────────────────────────────────────

// Conservative: small enough that input + 4096 max_tokens fits under
// Groq free-tier 6K TPM on llama-3.1-8b-instant. Anthropic handles this
// comfortably too — just more, cheaper batches.
const ENRICH_BATCH_CHARS = 4000;

function buildBatches(blocks: SegmentedBlock[]): SegmentedBlock[][] {
  const batches: SegmentedBlock[][] = [];
  let current: SegmentedBlock[] = [];
  let chars = 0;
  for (const b of blocks) {
    const len = b.text.length + 60; // +60 for [BLOCK N] header
    if (chars + len > ENRICH_BATCH_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(b);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ─── Serialise blocks for the LLM ────────────────────────────────────────────

function serialiseBlock(b: SegmentedBlock, idx: number): string {
  const prior = HINT_TO_PRIOR[b.hint] ?? 'mechanism';
  const conf = b.hintConfidence === 2 ? 'strong' : b.hintConfidence === 1 ? 'likely' : 'ambiguous';
  return `[BLOCK ${idx}] hint=${b.hint}(${conf}) prior=${prior} p${b.page}\n${b.text}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

// Contract: ../../../../contracts/enrich.md (CONTRACT_VERSION). Key invariants:
// never change block boundaries or reading order (one entry per input idx);
// ground claim/quote in that block (example_quote must be verbatim). Bump
// CONTRACT_VERSION if these change.
export async function runEnricher(
  config: ProviderConfig,
  blocks: SegmentedBlock[],
  sections: SectionNode[] = [],
): Promise<ExtractedChunk[]> {
  if (!blocks.length) return [];

  const results: ExtractedChunk[] = [];

  // Build section path lookup from geometry headings (no LLM cost)
  const { paths: sectionPath } = buildSectionPath(blocks, sections);

  for (const batch of buildBatches(blocks)) {
    const offset = results.length;
    const userContent = batch
      .map((b, i) => serialiseBlock(b, offset + i))
      .join('\n\n---\n\n');

    const { content } = await chatJSON(
      config,
      {
        messages: [
          { role: 'system', content: ENRICH_SYSTEM },
          { role: 'user', content: userContent },
        ],
        responseFormat: 'json',
        temperature: 0.1,
        maxTokens: 16000,
      },
      'enrich',
    );

    const raw = content || '{"enriched":[]}';
    let parsed: {
      enriched?: Array<{
        idx: number;
        block_type: string;
        claim: string | null;
        assumptions: string[];
        example_quote: string | null;
      }>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Output truncated or malformed — skip enrichment for this batch and
      // fall through with empty enrichment. Geometry hints + hint priors will
      // still produce usable chunks.
      console.warn(
        `[ENRICH] JSON parse failed (batch of ${batch.length} blocks, ${raw.length} chars output). ` +
        `Falling back to hint priors. err=${err instanceof Error ? err.message : String(err)}`,
      );
      parsed = { enriched: [] };
    }

    const enriched = parsed.enriched ?? [];
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      const e = enriched.find(x => x.idx === offset + i);
      const fallback = HINT_TO_PRIOR[b.hint] ?? 'mechanism';
      const candidate = e?.block_type ?? fallback;
      const block_type = (VALID_BLOCK_TYPES.has(candidate) ? candidate : fallback) as BlockType;
      results.push({
        content: b.text,
        page_start: b.page,
        page_end: b.page,
        block_type,
        section_path: sectionPath.get(b.readingOrder) ?? [],
        claim: e?.claim ?? null,
        assumptions: e?.assumptions ?? [],
        example_quote: e?.example_quote ?? null,
      });
    }
  }

  return results;
}

// ─── Section path from geometry headings ──────────────────────────────────────
// Headings detected by the geometry layer give us the section hierarchy for free.
// This replaces runStructureExtractor entirely for PDFs.

// Where a block's section breadcrumb came from. Useful for parser debugging:
// 'running_header' paths are coarse fallbacks, 'in_body_heading' are precise,
// 'mixed' means a running header was layered above a (weak) in-body heading.
export type SectionSource = 'none' | 'in_body_heading' | 'running_header' | 'mixed';

// headingConfidence at/above this is considered strong enough that a running
// header should NOT overpower it.
const STRONG_HEADING = 0.6;

export interface SectionPathResult {
  paths: Map<number, string[]>;
  sources: Map<number, SectionSource>;
}

export function buildSectionPath(
  blocks: SegmentedBlock[],
  extraSections: SectionNode[],
): SectionPathResult {
  const pathMap = new Map<number, string[]>();
  const sourceMap = new Map<number, SectionSource>();
  // Per-block: was the active in-body heading strong? Drives whether a running
  // header may be layered on top.
  const strongMap = new Map<number, boolean>();
  const currentPath: string[] = [];
  let currentFromBody = false;
  let currentStrong = false;

  for (const b of blocks) {
    if (b.hint === 'heading' && b.hintConfidence >= 1) {
      currentPath.length = 0;
      currentPath.push(b.text.slice(0, 80));
      currentFromBody = true;
      currentStrong = (b.signals.headingConfidence ?? 1) >= STRONG_HEADING;
    } else if (b.hint === 'subheading' && b.hintConfidence >= 1) {
      if (currentPath.length > 1) currentPath.pop();
      currentPath.push(b.text.slice(0, 80));
      currentFromBody = true;
      currentStrong = (b.signals.headingConfidence ?? 0.5) >= STRONG_HEADING;
    }
    pathMap.set(b.readingOrder, [...currentPath]);
    sourceMap.set(b.readingOrder, currentFromBody ? 'in_body_heading' : 'none');
    strongMap.set(b.readingOrder, currentFromBody && currentStrong);
  }

  // Layer running-header (or other extra) sections ONLY onto blocks that lack a
  // strong in-body section path — otherwise the running header overpowers real
  // local structure. Blocks with a strong in-body heading are left untouched.
  for (const s of extraSections) {
    for (const [order, path] of pathMap) {
      const b = blocks.find(x => x.readingOrder === order);
      if (!b || b.page < s.page_start || b.page > s.page_end) continue;
      if (strongMap.get(order)) continue;          // don't overpower strong local structure
      if (path.includes(s.heading)) continue;
      path.unshift(s.heading);
      const prev = sourceMap.get(order) ?? 'none';
      sourceMap.set(order, prev === 'in_body_heading' ? 'mixed' : 'running_header');
    }
  }

  return { paths: pathMap, sources: sourceMap };
}
