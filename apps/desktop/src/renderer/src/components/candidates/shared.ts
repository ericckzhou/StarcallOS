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
  high:        'High',
  medium:      'Medium',
  low:         'Low',
  suspicious:  'Suspicious',
  off_topic:   'Off-topic',
  boilerplate: 'Boilerplate',
  broad:       'Too broad',
};

// Buckets are a funnel: a candidate falls into the FIRST category it matches
// (boilerplate → too broad → suspicious → high/medium/low → off-topic). So the
// score tiers only hold candidates NOT already flagged — e.g. a 0.25 item that
// is suspicious lands in Suspicious, never in Low. Tooltips spell this out so
// the score ranges don't read as pure filters.
export const BUCKET_HINT: Record<Bucket, string> = {
  all:         'Every candidate, regardless of bucket.',
  high:        'Score ≥ 0.80 and not flagged as suspicious, too broad, or boilerplate.',
  medium:      'Score 0.55–0.79 and not flagged as suspicious, too broad, or boilerplate.',
  low:         'Score < 0.55 and not flagged. Flagged low-score items appear under Suspicious / Too broad / Boilerplate instead, which take precedence over score.',
  suspicious:  'Flagged as likely non-concept (sentence fragment, all-caps, no quote, symbols…). Takes precedence over the score tier, at any score.',
  off_topic:   'Topic-relevance below 0.15 — almost certainly outside this source\'s subject.',
  boilerplate: 'Front/back-matter or template text (copyright, TOC, headers).',
  broad:       'Too broad to be a single concept (e.g. a whole chapter title).',
};

export const SIGNAL_COLOR: Record<string, string> = {
  heading:            '#f59e0b',
  definition_pattern: '#22c55e',
  bold_block:         '#a855f7',
  repetition:         '#22d3ee',
  capitalized_phrase: '#6b7280',
  section_heading:    '#2563eb',
  weak_heading:       '#2563eb',
  defined_term:       '#22c55e',
  bold_emphasis:      '#a855f7',
  large_font:         '#3b82f6',
  repeated_term:      '#2563eb',
  domain_phrase:      '#2563eb',
  sentence_fragment:  '#ef4444',
  caption_or_figure:  '#ef4444',
  toc_or_index:       '#ef4444',
  low_context:        '#ef4444',
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
  if (c >= 0.8) return '#22c55e';
  if (c >= 0.55) return '#818cf8';
  if (c >= 0.3) return '#f59e0b';
  return '#6b7280';
}

export function isSuspicious(c: ConceptCandidate): boolean {
  const labels = new Set(c.labels ?? []);
  if (labels.has('sentence_fragment') || labels.has('caption_or_figure') || labels.has('toc_or_index') || labels.has('low_context')) return true;
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
  const score = c.final_score ?? c.concept_score ?? c.confidence;
  if (c.is_boilerplate)                                return 'boilerplate';
  if (c.is_broad)                                      return 'broad';
  if (isSuspicious(c))                                 return 'suspicious';
  if (score >= 0.8)                                    return 'high';
  if ((c.topic_relevance_score ?? 1.0) < 0.15)         return 'off_topic';
  if (score >= 0.55)                                   return 'medium';
  return 'low';
}

export function passesBulkPromoteGate(c: ConceptCandidate & { bucket: Bucket }): boolean {
  if (c.is_boilerplate) return false;
  if (c.is_broad) return false;
  if (c.bucket === 'suspicious') return false;
  if ((c.topic_relevance_score ?? 1.0) < 0.55) return false;
  if ((c.final_score ?? c.concept_score ?? c.confidence) < 0.8) return false;
  const signals = new Set(c.signals ?? []);
  const labels = new Set(c.labels ?? []);
  const hasSupport = signals.has('definition_pattern') ||
    ((c.typography_score ?? 0) >= 0.65 && (labels.has('section_heading') || labels.has('large_font'))) ||
    (signals.has('repetition') && labels.has('domain_phrase') && c.mention_count >= 4);
  if (!hasSupport) return false;
  return true;
}

export const CANDIDATE_FILTER_CHIPS: Array<{ key: string; label: string; color: string; kind: 'signal' | 'label' }> = [
  { key: 'heading',            label: 'Heading',        color: SIGNAL_COLOR.heading,            kind: 'signal' },
  { key: 'definition_pattern', label: 'Definition',     color: SIGNAL_COLOR.definition_pattern, kind: 'signal' },
  { key: 'bold_block',         label: 'Bold',           color: SIGNAL_COLOR.bold_block,         kind: 'signal' },
  { key: 'repetition',         label: 'Repetition',     color: SIGNAL_COLOR.repetition,         kind: 'signal' },
  { key: 'capitalized_phrase', label: 'Cap. phrase',    color: SIGNAL_COLOR.capitalized_phrase, kind: 'signal' },
  { key: 'section_heading',    label: 'Section heading', color: SIGNAL_COLOR.section_heading,   kind: 'label' },
  { key: 'weak_heading',       label: 'Weak heading',   color: SIGNAL_COLOR.weak_heading,       kind: 'label' },
  { key: 'defined_term',       label: 'Defined term',   color: SIGNAL_COLOR.defined_term,       kind: 'label' },
  { key: 'bold_emphasis',      label: 'Bold emphasis',  color: SIGNAL_COLOR.bold_emphasis,      kind: 'label' },
  { key: 'large_font',         label: 'Large font',     color: SIGNAL_COLOR.large_font,         kind: 'label' },
  { key: 'repeated_term',      label: 'Repeated term',  color: SIGNAL_COLOR.repeated_term,      kind: 'label' },
  { key: 'domain_phrase',      label: 'Domain phrase',  color: SIGNAL_COLOR.domain_phrase,      kind: 'label' },
  { key: 'sentence_fragment',  label: 'Fragment',       color: SIGNAL_COLOR.sentence_fragment,  kind: 'label' },
  { key: 'caption_or_figure',  label: 'Caption/figure', color: SIGNAL_COLOR.caption_or_figure,  kind: 'label' },
  { key: 'toc_or_index',       label: 'TOC/index',      color: SIGNAL_COLOR.toc_or_index,       kind: 'label' },
  { key: 'low_context',        label: 'Low context',    color: SIGNAL_COLOR.low_context,        kind: 'label' },
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
