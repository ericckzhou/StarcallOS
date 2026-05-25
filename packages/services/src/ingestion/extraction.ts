import type { PageText } from './pdf';
import type {
  BlockType,
  SectionNode,
  ConceptImportance,
  EdgeType,
  EvidenceKind,
} from '../core/domain/types';
import { chatJSON, type ProviderConfig } from '../core/llm';

// ─── Response types ───────────────────────────────────────────────────────────

export type { SectionNode };

export interface ExtractedChunk {
  content: string;
  page_start: number;
  page_end: number;
  block_type: BlockType;
  section_path: string[];   // assigned from section tree, no LLM cost
  claim: string | null;
  assumptions: string[];
  example_quote: string | null;
}

export interface ExtractedConcept {
  name: string;
  slug: string;
  importance: ConceptImportance;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string[];
  chunk_indices: number[];
  section_path: string[];
  exam_value: number;         // 0–1
  misconception_risk: number; // 0–1
}

export interface ExtractedEdge {
  from_slug: string;
  to_slug: string;
  edge_type: EdgeType;
}

export interface ExtractedMisconception {
  concept_slug: string;
  description: string;
  why_think_it: string;
  why_wrong: string;
  test_prompt: string;
}

export interface ExtractedTask {
  concept_slug: string;
  kind: EvidenceKind;
  prompt: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sectionPathForPage(page: number, sections: SectionNode[]): string[] {
  return sections
    .filter(s => s.page_start <= page && s.page_end >= page)
    .map(s => s.heading);
}

// ─── Pass 0: Structure extraction ─────────────────────────────────────────────

const STRUCTURE_SYSTEM = `You are a document structure parser for academic textbooks.
Given page text with [PAGE N] markers, recover the heading hierarchy.

Rules:
- Only include headings that explicitly appear in the text (numbered chapters, sections, subsections).
- level: 1=chapter, 2=section, 3=subsection, 4=named paragraph group.
- page_end = the page before the next same-or-higher-level section starts, or the last page seen.
- Equations, figures, captions, and table entries are NOT headings.

Respond ONLY with JSON: { "sections": [...] }
Each section: { "heading": "...", "level": 1|2|3|4, "page_start": N, "page_end": N }`;

const STRUCTURE_MAX_PAGES = 50;

export async function runStructureExtractor(
  config: ProviderConfig,
  pages: PageText[],
): Promise<SectionNode[]> {
  // Compress to first 3 lines per page — enough to catch headings cheaply.
  // Cap at STRUCTURE_MAX_PAGES to stay within free-tier token limits.
  const compressed = pages
    .slice(0, STRUCTURE_MAX_PAGES)
    .map(p => {
      const preview = p.text.split('\n').slice(0, 3).join(' ').trim().slice(0, 120);
      return `[PAGE ${p.page}] ${preview}`;
    })
    .join('\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: STRUCTURE_SYSTEM },
        { role: 'user', content: compressed },
      ],
      responseFormat: 'json',
      temperature: 0.0,
    },
    'structure',
  );

  const parsed = JSON.parse(content || '{"sections":[]}') as { sections?: SectionNode[] };
  return parsed.sections ?? [];
}

// ─── Pass 1: Block detection ──────────────────────────────────────────────────

const BLOCK_SYSTEM = `You are a semantic block detector for academic ML/AI textbooks.
Split the input into concept-boundary blocks — one coherent learning unit per block.

Block types:
- definition: introduces and defines a concept
- theorem: a formal claim proven or assumed
- mechanism: explains how something works
- example: concrete instance of an abstract idea
- derivation: mathematical development or proof steps
- claim: an assertion about how something behaves (not yet proven)
- evidence: empirical or experimental support for a claim
- warning: common mistake, failure mode, or misconception zone
- formula: a key equation or algorithm statement
- procedure: step-by-step process or algorithm
- comparison: contrasts two or more concepts
- assumption: a stated prerequisite or simplification
- transition: connective tissue between ideas

For each block also extract:
- claim: the single core assertion this block makes (null if not applicable)
- assumptions: list of stated or implied prerequisites for this block to hold
- example_quote: the best verbatim example sentence from this block (null if none)

Respond ONLY with JSON: { "blocks": [...] }
Each block: { "content": "...", "page_start": N, "page_end": N, "block_type": "...",
              "claim": "..."|null, "assumptions": [...], "example_quote": "..."|null }`;

// ~5 000 chars ≈ 1 250 tokens — leaves headroom under the 6 000 TPM free-tier limit
const CHUNK_BATCH_CHARS = 5000;

function buildChunkerBatches(pages: PageText[]): PageText[][] {
  const batches: PageText[][] = [];
  let current: PageText[] = [];
  let chars = 0;
  for (const p of pages) {
    const len = p.text.length + 12; // account for [PAGE N]\n prefix
    if (chars + len > CHUNK_BATCH_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function runChunker(
  config: ProviderConfig,
  pages: PageText[],
  sections: SectionNode[] = [],
): Promise<ExtractedChunk[]> {
  const allChunks: ExtractedChunk[] = [];

  for (const batch of buildChunkerBatches(pages)) {
    const pagesText = batch
      .map(p => `[PAGE ${p.page}]\n${p.text}`)
      .join('\n\n');

    const { content } = await chatJSON(
      config,
      {
        messages: [
          { role: 'system', content: BLOCK_SYSTEM },
          { role: 'user', content: pagesText },
        ],
        responseFormat: 'json',
        temperature: 0.1,
        maxTokens: 16000,
      },
      'chunker',
    );

    const parsed = JSON.parse(content || '{"blocks":[]}') as {
      blocks?: Array<{
        content: string;
        page_start: number;
        page_end: number;
        block_type: string;
        claim: string | null;
        assumptions: string[];
        example_quote: string | null;
      }>;
    };

    const batchChunks = (parsed.blocks ?? []).map(b => ({
      content: b.content,
      page_start: b.page_start,
      page_end: b.page_end,
      block_type: b.block_type as BlockType,
      section_path: sectionPathForPage(b.page_start, sections),
      claim: b.claim ?? null,
      assumptions: b.assumptions ?? [],
      example_quote: b.example_quote ?? null,
    }));

    allChunks.push(...batchChunks);
  }

  return allChunks;
}

// ─── Pass 2: Concept extraction ───────────────────────────────────────────────

const CONCEPT_SYSTEM = `You are an expert knowledge extractor for ML/AI texts.
Given semantic blocks from a source document, extract all meaningful concepts.

For each concept output:
- name: clear canonical name
- slug: kebab-case identifier
- importance: "foundational"|"core"|"supporting"|"peripheral"|"reference_only"
  foundational = prerequisite to most of the field
  core = central to this document
  supporting = helps explain core concepts
  peripheral = mentioned but not central
  reference_only = cited, not explained
- definition_text: precise one-paragraph definition
- why_exists: why this concept was invented / what problem it solves
- what_breaks: what fails or becomes impossible without this concept
- where_reappears: list of OTHER concept names that build on this one
- chunk_indices: 0-based indices of blocks this concept appears in
- section_path: list of heading strings where this concept is first defined
- exam_value: 0.0–1.0 — how likely is this to appear in an assessment?
- misconception_risk: 0.0–1.0 — how easy is it to misunderstand this?

Respond ONLY with JSON: { "concepts": [...] }`;

export async function runConceptExtractor(
  config: ProviderConfig,
  chunks: ExtractedChunk[],
): Promise<ExtractedConcept[]> {
  const chunksText = chunks
    .map((c, i) => {
      const path = c.section_path.length > 0 ? ` [${c.section_path.join(' > ')}]` : '';
      return `[BLOCK ${i}] (${c.block_type})${path}\n${c.content}`;
    })
    .join('\n\n---\n\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: CONCEPT_SYSTEM },
        { role: 'user', content: chunksText },
      ],
      responseFormat: 'json',
      temperature: 0.1,
    },
    'concepts',
  );

  const parsed = JSON.parse(content || '{"concepts":[]}') as { concepts?: ExtractedConcept[] };
  return (parsed.concepts ?? []).map(c => ({
    ...c,
    section_path: c.section_path ?? [],
    exam_value: Math.min(1, Math.max(0, c.exam_value ?? 0)),
    misconception_risk: Math.min(1, Math.max(0, c.misconception_risk ?? 0)),
  }));
}

// ─── Pass 3: Dependency graph ─────────────────────────────────────────────────

const GRAPH_SYSTEM = `You are a knowledge graph builder for ML/AI concepts.
Given a list of concepts (slug: definition), identify dependency edges.

Edge types:
- requires: to_slug cannot be understood without from_slug
- enables: from_slug makes to_slug possible or easier
- related: conceptually adjacent, neither strictly depends on the other
- contrasts_with: the two are often confused or opposed
- example_of: from_slug is a concrete instance of to_slug
- causes: from_slug directly produces or leads to to_slug
- prevents: from_slug blocks or mitigates to_slug

Include only edges with genuine epistemic value. Omit superficial co-occurrence.

Respond ONLY with JSON: { "edges": [...] }
Each edge: { "from_slug": "...", "to_slug": "...", "edge_type": "..." }`;

export async function runGraphBuilder(
  config: ProviderConfig,
  concepts: ExtractedConcept[],
): Promise<ExtractedEdge[]> {
  const conceptList = concepts
    .map(c => `- ${c.slug}: ${c.definition_text}`)
    .join('\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: GRAPH_SYSTEM },
        { role: 'user', content: conceptList },
      ],
      responseFormat: 'json',
      temperature: 0.1,
    },
    'graph',
  );

  const parsed = JSON.parse(content || '{"edges":[]}') as { edges?: ExtractedEdge[] };
  return parsed.edges ?? [];
}

// ─── Pass 4: Misconception extraction ────────────────────────────────────────

const MISCONCEPTION_SYSTEM = `You are an expert in common ML/AI learning failures.
Given foundational and core concepts with their misconception_risk scores,
identify the most likely misconceptions learners form about each one.

For each misconception:
- concept_slug: which concept this is about
- description: the specific wrong belief (stated as the learner would hold it)
- why_think_it: why a reasonable learner would form this wrong belief
- why_wrong: the precise reason this belief fails
- test_prompt: a task that exposes this misconception

Prioritise high-risk concepts. Limit to 1–3 misconceptions per concept.

Respond ONLY with JSON: { "misconceptions": [...] }`;

export async function runMisconceptionExtractor(
  config: ProviderConfig,
  concepts: ExtractedConcept[],
): Promise<ExtractedMisconception[]> {
  const targets = concepts.filter(
    c => c.importance === 'foundational' || c.importance === 'core',
  );

  if (targets.length === 0) return [];

  const conceptList = targets
    .map(c => `- ${c.slug} (risk: ${c.misconception_risk.toFixed(2)}): ${c.definition_text}`)
    .join('\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: MISCONCEPTION_SYSTEM },
        { role: 'user', content: conceptList },
      ],
      responseFormat: 'json',
      temperature: 0.2,
    },
    'misconceptions',
  );

  const parsed = JSON.parse(content || '{"misconceptions":[]}') as { misconceptions?: ExtractedMisconception[] };
  return parsed.misconceptions ?? [];
}

// ─── Pass 5: Evidence task generation ────────────────────────────────────────

const TASK_SYSTEM = `You are an expert in evidence-based learning.
Given a concept's name, definition, importance, and misconception_risk, generate exactly 5 evidence tasks —
one per kind: definition, connection, application, misconception_resistance, compression.

Tasks must require genuine understanding, not recall.
Calibrate difficulty (1–5): foundational=3-5, core=2-4, supporting=1-3, peripheral=1-2.
Weight difficulty upward for concepts with high misconception_risk.

compression: express the core idea in 1–2 sentences without using the concept name.
misconception_resistance: present a scenario with a hidden wrong assumption and ask the learner to identify and correct it.

Respond ONLY with JSON: { "tasks": [...] }
Each task: { "concept_slug": "...", "kind": "...", "prompt": "...", "difficulty": N }`;

export async function runTaskGenerator(
  config: ProviderConfig,
  concepts: ExtractedConcept[],
): Promise<ExtractedTask[]> {
  const tasks: ExtractedTask[] = [];

  for (let i = 0; i < concepts.length; i += 5) {
    const batch = concepts.slice(i, i + 5);
    const batchText = batch
      .map(
        c =>
          `Concept: ${c.name} (${c.slug})\nImportance: ${c.importance}\nMisconception risk: ${c.misconception_risk.toFixed(2)}\nDefinition: ${c.definition_text}`,
      )
      .join('\n\n---\n\n');

    const { content } = await chatJSON(
      config,
      {
        messages: [
          { role: 'system', content: TASK_SYSTEM },
          { role: 'user', content: batchText },
        ],
        responseFormat: 'json',
        temperature: 0.3,
      },
      'tasks',
    );

    const parsed = JSON.parse(content || '{"tasks":[]}') as { tasks?: ExtractedTask[] };
    tasks.push(...(parsed.tasks ?? []));
  }

  return tasks;
}

// ─── Pass 6: Centrality scoring (no LLM) ─────────────────────────────────────

export function computeCentrality(
  conceptIds: number[],
  edges: Array<{ from_id: number; to_id: number }>,
): Map<number, number> {
  const degree = new Map<number, number>(conceptIds.map(id => [id, 0]));
  for (const e of edges) {
    degree.set(e.from_id, (degree.get(e.from_id) ?? 0) + 1);
    degree.set(e.to_id, (degree.get(e.to_id) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  return new Map([...degree.entries()].map(([id, d]) => [id, d / maxDegree]));
}
