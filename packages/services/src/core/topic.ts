// Deterministic topic-fit utilities.
//   - BOILERPLATE_HEADINGS: section names that are noise regardless of book.
//   - deriveTopicAnchors: cheap per-source signal of what the book is about.
//   - scoreTopicRelevance: per-candidate Jaccard-ish fit against anchors.
//
// No LLM, no embeddings. Goal is "obviously off-topic" rejection, not nuance.

import type { SegmentedBlock } from '../ingestion/layout';

// ─── Boilerplate ──────────────────────────────────────────────────────────────

export const BOILERPLATE_HEADINGS = new Set<string>([
  'summary', 'summaries',
  'conclusion', 'conclusions',
  'introduction', 'preface', 'foreword', 'prologue', 'epilogue',
  'exercises', 'problems', 'solutions', 'answers',
  'references', 'bibliography', 'further reading',
  'notes', 'footnotes', 'endnotes',
  'appendix', 'appendices',
  'index', 'indices',
  'glossary',
  'acknowledgments', 'acknowledgements',
  'table of contents', 'contents',
  'about the author', 'about the authors', 'about this book',
  'overview',
  'figure', 'figures', 'table', 'tables',
  'chapter', 'chapters', 'section', 'sections',
  'part', 'parts',
  'abstract',
  'discussion', 'discussions',
  'methodology', 'methods',
  'results',
  'background',
  'related work',
  'future work',
  'copyright', 'license', 'disclaimer',
  'errata',
  'reviews',
]);

export function isBoilerplateHeading(normalized: string): boolean {
  return BOILERPLATE_HEADINGS.has(normalized);
}

// ─── Anchor derivation ────────────────────────────────────────────────────────

const STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'for', 'to', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those',
  'it', 'its', 'we', 'our', 'you', 'your', 'they', 'their',
  'as', 'at', 'by', 'from', 'into', 'about', 'over', 'under',
  'how', 'why', 'what', 'when', 'where',
  'can', 'will', 'would', 'should', 'could', 'may', 'might',
  'introduction', 'overview', 'summary', 'chapter', 'part', 'section',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Builds a small set of topic anchor tokens for the source.
 * Sources: book title + the most frequent tokens that appear in heading blocks.
 * Returns deduplicated, lowercased single-tokens (no phrases).
 */
export function deriveTopicAnchors(blocks: SegmentedBlock[], title: string | null | undefined, maxAnchors = 80): string[] {
  const counts = new Map<string, number>();

  // Title is the strongest signal — weight ×3
  if (title) {
    for (const t of tokens(title)) counts.set(t, (counts.get(t) ?? 0) + 3);
  }

  // Heading tokens
  for (const b of blocks) {
    if ((b.hint === 'heading' || b.hint === 'subheading') && b.hintConfidence >= 1) {
      for (const t of tokens(b.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  // Sort by frequency, take top N
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxAnchors)
    .map(([term]) => term);
}

// ─── Per-candidate scoring ────────────────────────────────────────────────────

export interface RelevanceResult {
  score: number;             // 0–1
  reasons: string[];         // human-readable anchor matches, capped
}

/**
 * Score how well a candidate fits the source's topic.
 *   score = (matched_anchor_weight) / (candidate_token_count, floored at 1)
 * Anchors that appear in the candidate term itself weight 2× more than ones
 * that only appear in evidence quotes.
 *
 * No anchors at all → score 1.0 (don't punish brand-new sources).
 */
export function scoreTopicRelevance(
  termTokens: string[],
  evidenceTokens: string[],
  anchors: string[],
): RelevanceResult {
  if (anchors.length === 0) return { score: 1.0, reasons: [] };

  const anchorSet = new Set(anchors);
  const termHits = termTokens.filter(t => anchorSet.has(t));
  const evHits   = evidenceTokens.filter(t => anchorSet.has(t));

  const weightedHits = termHits.length * 2 + evHits.length;
  const denominator  = Math.max(1, termTokens.length * 2 + Math.min(evidenceTokens.length, 20));
  const raw = weightedHits / denominator;
  const score = Math.min(1, raw);

  const reasons: string[] = [];
  if (termHits.length > 0)  reasons.push(`term: ${[...new Set(termHits)].slice(0, 5).join(', ')}`);
  if (evHits.length > 0)    reasons.push(`evidence: ${[...new Set(evHits)].slice(0, 5).join(', ')}`);

  return { score: +score.toFixed(3), reasons };
}

export function tokenize(s: string): string[] {
  return tokens(s);
}
