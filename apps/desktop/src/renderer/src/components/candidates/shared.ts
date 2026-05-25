// Types, color palettes, and pure-function helpers shared across the
// CandidateReview panels and modals.

import type { CandidatesBundle } from '@starcall/shared';

// Lightweight aliases so panel files don't reach into shared internals.

export type EvidenceSpan         = CandidatesBundle['concepts'][number]['evidence'][number];
export type ConceptCandidate     = CandidatesBundle['concepts'][number];
export type RelationCandidate    = CandidatesBundle['relations'][number];
export type MisconceptionCandidate = CandidatesBundle['misconceptions'][number];
export type EquationCandidate    = CandidatesBundle['equations'][number];
export type Bundle               = CandidatesBundle;

export type SubTab = 'concepts' | 'relations' | 'misconceptions' | 'equations';
export type Bucket = 'all' | 'high' | 'medium' | 'low' | 'suspicious' | 'off_topic' | 'boilerplate' | 'broad';

export interface TopicFitDecision {
  id?: number;
  term?: string;
  keep: boolean;
}

export interface TopicFitResponse {
  decisions?: TopicFitDecision[];
}

// Color palettes.

export const BUCKET_COLOR: Record<Bucket, string> = {
  all:         '#9ca3af',
  high:        '#22c55e',
  medium:      '#818cf8',
  low:         '#f59e0b',
  suspicious:  '#ef4444',
  off_topic:   '#a855f7',
  boilerplate: '#6b7280',
  broad:       '#06b6d4',
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  all:         'All',
  high:        'High (>=0.85)',
  medium:      'Medium (0.55-0.84)',
  low:         'Low (<0.55)',
  suspicious:  'Suspicious',
  off_topic:   'Off-topic',
  boilerplate: 'Boilerplate',
  broad:       'Too broad',
};

export const SIGNAL_COLOR: Record<string, string> = {
  heading:            '#f59e0b',
  definition_pattern: '#22c55e',
  bold_block:         '#a855f7',
  repetition:         '#22d3ee',
  capitalized_phrase: '#6b7280',
};

export const RELATION_COLOR: Record<string, string> = {
  requires:       '#f59e0b',
  causes:         '#ef4444',
  enables:        '#22c55e',
  contrasts_with: '#a855f7',
  example_of:     '#22d3ee',
};

// Pure-function helpers.

export function confColor(c: number): string {
  if (c >= 0.9) return '#22c55e';
  if (c >= 0.55) return '#818cf8';
  if (c >= 0.3) return '#f59e0b';
  return '#6b7280';
}

export function isSuspicious(c: ConceptCandidate): boolean {
  const hasAnyQuote = c.evidence.some(e => e.quote && e.quote.trim().length > 0);
  if (c.confidence >= 0.7 && !hasAnyQuote) return true;
  if (c.term.length > 80) return true;
  if (c.term.replace(/\s+/g, '').length <= 1) return true;
  if (/[\\{}=<>∑∫∂∇αβγδεζηθικλμνξπρστυφχψω]/.test(c.term)) return true;
  if (c.term.includes('```') || c.term.startsWith('`')) return true;
  if (c.term.length >= 30 && /[A-Z]/.test(c.term) && c.term === c.term.toUpperCase()) return true;
  return false;
}

export function classifyBucket(c: ConceptCandidate): Bucket {
  if (c.is_boilerplate)                                return 'boilerplate';
  if (c.is_broad)                                      return 'broad';
  if (isSuspicious(c))                                 return 'suspicious';
  if (c.confidence >= 0.85)                            return 'high';
  if ((c.topic_relevance_score ?? 1.0) < 0.15)         return 'off_topic';
  if (c.confidence >= 0.55)                            return 'medium';
  return 'low';
}

export function passesBulkPromoteGate(c: ConceptCandidate & { bucket: Bucket }): boolean {
  if (c.is_boilerplate) return false;
  if (c.is_broad) return false;
  if (c.bucket === 'suspicious') return false;
  if ((c.topic_relevance_score ?? 1.0) < 0.55) return false;
  if (c.confidence < 0.9) return false;
  if (c.mention_count < 2) return false;
  return true;
}

export const SIGNAL_CHIPS: Array<{ key: string; label: string; color: string }> = [
  { key: 'any',                label: 'Any signal',   color: '#9ca3af' },
  { key: 'heading',            label: 'Heading',      color: SIGNAL_COLOR.heading },
  { key: 'definition_pattern', label: 'Definition',   color: SIGNAL_COLOR.definition_pattern },
  { key: 'bold_block',         label: 'Bold',         color: SIGNAL_COLOR.bold_block },
  { key: 'repetition',         label: 'Repetition',   color: SIGNAL_COLOR.repetition },
  { key: 'capitalized_phrase', label: 'Cap. phrase',  color: SIGNAL_COLOR.capitalized_phrase },
];

export function parseTopicFitJson(raw: string): TopicFitResponse | null {
  if (!raw.trim()) return null;
  let body = raw.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(body) as TopicFitResponse;
    if (!Array.isArray(obj.decisions)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function buildTopicFitPrompt(
  sourceTitle: string | undefined,
  candidates: Array<Pick<ConceptCandidate, 'normalized' | 'term' | 'mention_count' | 'first_page'>>,
): string {
  const list = candidates.slice(0, 400).map(c =>
    JSON.stringify({
      term: c.normalized,
      display: c.term,
      mentions: c.mention_count,
      page: c.first_page,
    }),
  ).join('\n');
  const title = sourceTitle || '(unknown source title)';
  return [
    `You're filtering candidate concepts extracted from a book.`,
    `Book title: "${title}"`,
    ``,
    `For each candidate below, decide whether it ACTUALLY belongs to this book's domain.`,
    `Reject: overly broad terms, boilerplate ("Summary", "References"), generic words, and concepts that aren't really about this book's subject.`,
    `Keep: concepts that a reader of this book would specifically want to learn.`,
    ``,
    `Candidates (one JSON object per line, use the "term" value as the key):`,
    list,
    ``,
    `Respond ONLY with this JSON shape (one entry per candidate term you decide on - you can omit ones you're unsure about):`,
    `{"decisions":[{"term":"<term verbatim>","keep":true|false}]}`,
  ].join('\n');
}
