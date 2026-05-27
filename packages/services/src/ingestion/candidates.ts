// Deterministic concept-candidate extractor.
// Contract: proposes evidence-backed candidates with a confidence score
// and a source label explaining WHY each candidate fired. Downstream
// promotion logic (or LLM refinement) decides which become real concepts.

import type { SegmentedBlock } from './layout';
import {
  findDefinitions,
  findRelations,
  findCapitalizedPhrases,
  findMisconceptionPhrases,
  type RelationKind,
} from './grammar';
import { looksLikeEquation, extractEquationsWithSections, type EquationCandidate } from './equations';
import { isBoilerplateHeading, scoreTopicRelevance, tokenize } from '../core/topic';
import {
  DOMAIN_TERMS,
  GENERIC_BAD_TERMS,
  CONNECTIVE_PREFIXES,
  PROSE_TAIL_WORDS,
  PROSE_HEAD_WORDS,
  COMMON_NAMES,
  ACRONYM_TO_EXPANSION,
} from '../core/lexicon';

// ─── Public types ─────────────────────────────────────────────────────────────

export type CandidateSource =
  | 'heading'
  | 'definition_pattern'
  | 'bold_block'
  | 'repetition'
  | 'capitalized_phrase';

export interface EvidenceSpan {
  source: CandidateSource;
  quote: string;
  page: number;
  pattern?: string;
}

export interface ConceptCandidate {
  term: string;
  normalized: string;     // lowercase, deduped key
  confidence: number;     // 0–1
  evidence: EvidenceSpan[];
  section_path: string[];
  first_page: number;
  mention_count: number;
  // Deterministic quality flags + topic fit. Default values mean
  // "don't apply this filter" so legacy callers don't need to opt in.
  topic_relevance_score: number;          // 0–1 (1.0 = anchors not available)
  topic_relevance_reasons: string[];
  is_boilerplate: boolean;
  is_broad: boolean;
  // Deterministic quality score (0–1). Combines heading, domain-term,
  // local context, recurrence, phrase quality. Used as the gate threshold
  // before the LLM filter runs.
  concept_score: number;
  typography_score?: number;
  signal_score?: number;
  quality_score?: number;
  context_score?: number;
  final_score?: number;
  labels?: string[];
  typography_signals?: Record<string, unknown>;
  context_snippet?: string;
  parser_diagnostics?: Record<string, unknown>;
  // Comma-joined reasons for low scores or rejection: 'fragment', 'generic',
  // 'connective_prefix', 'prose_tail', 'name', 'boilerplate', 'broad'.
  // Empty when the candidate passes all deterministic gates cleanly.
  reject_reasons: string[];
}

export interface RelationCandidate {
  from: string;
  to: string;
  kind: RelationKind;
  quote: string;
  page: number;
}

export interface CandidateExtractionResult {
  candidates: ConceptCandidate[];
  relations: RelationCandidate[];
  misconception_phrases: Array<{ quote: string; page: number; section_path: string[] }>;
  equations: EquationCandidate[];
  diagnostics: {
    blocks_seen: number;
    headings_seen: number;
    definitions_found: number;
    capitalized_phrases_unique: number;
    repetition_promoted: number;
    equations_found: number;
    rejected_headings: number;
    typography_backed_candidates: number;
    fragments: number;
    toc_index_blocks: number;
    contextless_candidates: number;
    final_score_high: number;
    final_score_medium: number;
    final_score_low: number;
  };
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

// Per-signal confidence contributions. Multiple signals stack additively up to 1.
const SIGNAL_WEIGHT: Record<CandidateSource, number> = {
  heading:            0.55,
  definition_pattern: 0.40,
  bold_block:         0.30,
  repetition:         0.25,
  capitalized_phrase: 0.10,
};

// A capitalized phrase needs to appear at least this many times across the
// document to be promoted from "capitalized" to "repetition".
const REPETITION_THRESHOLD = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Conservative inflectional stemmer — strips `s|es|ing|ed` only, and only when
// the resulting stem is ≥4 chars. Preserves "is", "es", "models" → "model",
// "training" → "train", "embedded" → "embed". Doesn't touch "data", "this".
function stemWord(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith('ing') && w.length >= 7) return w.slice(0, -3);
  if (w.endsWith('ed')  && w.length >= 6) return w.slice(0, -2);
  if (w.endsWith('es')  && w.length >= 6) return w.slice(0, -2);
  if (w.endsWith('s')   && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length >= 5) {
    return w.slice(0, -1);
  }
  return w;
}

function normalize(term: string): string {
  const raw = term.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // Phrase-level acronym alias: "RAG" → "retrieval augmented generation"
  if (ACRONYM_TO_EXPANSION[raw]) return ACRONYM_TO_EXPANSION[raw];
  // Per-token stem; preserves hyphens as joining char.
  const stemmed = raw
    .split(/\s+/)
    .map(tok => tok.split('-').map(stemWord).join('-'))
    .join(' ')
    .trim();
  // Try alias on the stemmed form too: "llms" stems to "llm" → expansion
  return ACRONYM_TO_EXPANSION[stemmed] ?? stemmed;
}

interface CandidateBuilder {
  term: string;
  normalized: string;
  evidence: EvidenceSpan[];
  pages: Set<number>;
  section_path: string[];
  signal_weights: Map<CandidateSource, number>;
  mention_count: number;
  labels: Set<string>;
  typographySignals: Record<string, unknown>;
  readingOrders: Set<number>;
  pagesForContext: Set<number>;
  diagnostics: Record<string, unknown>;
}

function ensure(map: Map<string, CandidateBuilder>, term: string, sectionPath: string[], page: number): CandidateBuilder {
  const key = normalize(term);
  let b = map.get(key);
  if (!b) {
    b = {
      term: term.trim(),
      normalized: key,
      evidence: [],
      pages: new Set<number>([page]),
      section_path: sectionPath,
      signal_weights: new Map(),
      mention_count: 0,
      labels: new Set(),
      typographySignals: {},
      readingOrders: new Set(),
      pagesForContext: new Set([page]),
      diagnostics: {},
    };
    map.set(key, b);
  }
  b.pages.add(page);
  b.pagesForContext.add(page);
  // Prefer the shortest section_path seen first (likely the defining section)
  if (sectionPath.length < b.section_path.length || b.section_path.length === 0) {
    b.section_path = sectionPath;
  }
  return b;
}

function addSignal(b: CandidateBuilder, source: CandidateSource, quote: string, page: number, pattern?: string): void {
  // A given source contributes at most once per candidate (no double-counting
  // ten definition hits on the same term).
  if (!b.signal_weights.has(source)) {
    b.signal_weights.set(source, SIGNAL_WEIGHT[source]);
  }
  if (b.evidence.length < 5) {
    b.evidence.push({ source, quote, page, pattern });
  }
  b.mention_count += 1;
}

function addBlockSignal(b: CandidateBuilder, block: SegmentedBlock, label?: string): void {
  b.readingOrders.add(block.readingOrder);
  b.pagesForContext.add(block.page);
  if (label) b.labels.add(label);
  const s = block.signals;
  const currentRatio = Number(b.typographySignals.fontSizeRatio ?? 0);
  if (s.fontSizeRatio > currentRatio) {
    b.typographySignals = {
      fontSizeRatio: s.fontSizeRatio,
      yGapAbove: s.yGapAbove,
      yGapBelow: s.yGapBelow ?? 0,
      isBold: s.isBold,
      isItalic: !!s.isItalic,
      isAllCaps: s.isAllCaps,
      isIsolatedLine: s.isIsolatedLine,
      lineCount: s.lineCount ?? 1,
      blockWidth: s.blockWidth ?? null,
      indentation: s.indentation ?? null,
      dominantFont: s.dominantFont ?? '',
      headingDepth: s.headingDepth ?? null,
      hint: block.hint,
      hintConfidence: block.hintConfidence,
    };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

function isBroadTerm(term: string, signalKeys: Set<CandidateSource>, mentionCount: number): boolean {
  const tokenCount = term.trim().split(/\s+/).filter(Boolean).length;
  if (tokenCount >= 2) return false;                  // multi-word terms are specific enough
  if (signalKeys.has('definition_pattern')) return false; // explicit definition → specific
  if (mentionCount >= 5) return false;                // appears frequently → meaningful
  if (term.length >= 12) return false;                // long single word like "Backpropagation"
  return true;
}

// ─── Quality gates ──────────────────────────────────────────────────────────

function tokensLower(term: string): string[] {
  return term.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

function equationFallbackTag(eq: EquationCandidate): string | null {
  const nearestSection = [...eq.section_path].reverse().find(s => s.trim().length > 0);
  return nearestSection ? normalize(nearestSection) : null;
}

// "From Large Language Models to" → fragment (trailing prep).
// "However Deep Learning"          → fragment (connective prefix).
// "Foo-"                            → fragment (trailing dash).
function isFragment(term: string): boolean {
  const t = term.trim();
  if (!t) return true;
  if (t.endsWith('-')) return true;
  if (/^(in this|for example|this example|these examples)\b/i.test(t)) return true;
  const toks = tokensLower(t);
  if (toks.length === 0) return true;
  if (PROSE_TAIL_WORDS.has(toks[toks.length - 1])) return true;
  if (CONNECTIVE_PREFIXES.has(toks[0])) return true;
  if (toks.length === 1 && (CONNECTIVE_PREFIXES.has(toks[0]) || PROSE_TAIL_WORDS.has(toks[0]))) return true;
  if (PROSE_HEAD_WORDS.has(toks[0]) && toks.length === 1) return true;
  return false;
}

function looksLikeCaptionOrFigure(term: string): boolean {
  return /^(fig(?:ure)?|table|algorithm|example|ex\.|eq(?:uation)?)[\s.:_-]*\d*/i.test(term.trim());
}

function looksLikeTocOrIndex(term: string): boolean {
  const t = term.trim();
  if (/[.·…]{3,}\s*\d{1,4}$/.test(t)) return true;
  if (/^\S.{4,}?\s{6,}\d{1,4}$/.test(t)) return true;
  if (/\b(contents|index)\b/i.test(t) && t.length < 40) return true;
  return false;
}

function isGenericRejected(normalizedTerm: string): boolean {
  return GENERIC_BAD_TERMS.has(normalizedTerm);
}

function looksLikeName(normalizedTerm: string): boolean {
  const toks = normalizedTerm.split(/\s+/).filter(Boolean);
  if (toks.length === 0 || toks.length > 3) return false;
  return toks.every(t => COMMON_NAMES.has(t));
}

// ─── Concept scoring ────────────────────────────────────────────────────────

export interface CandidateScoreParts {
  typography_score: number;
  signal_score: number;
  quality_score: number;
  context_score: number;
  final_score: number;
}

function scoreCandidate(
  signalKeys: Set<CandidateSource>,
  evidence: EvidenceSpan[],
  mentionCount: number,
  termTokens: string[],
  topicRelevance: number,
  isFlaggedReject: boolean,
  typographySignals: Record<string, unknown>,
  labels: Set<string>,
): CandidateScoreParts {
  const fontSizeRatio = Number(typographySignals.fontSizeRatio ?? 1);
  const yGapAbove = Number(typographySignals.yGapAbove ?? 0);
  const yGapBelow = Number(typographySignals.yGapBelow ?? 0);
  const isBold = typographySignals.isBold === true;
  const isIsolatedLine = typographySignals.isIsolatedLine === true;
  const typography_score = Math.min(1,
    (fontSizeRatio >= 1.35 ? 0.35 : fontSizeRatio >= 1.15 ? 0.18 : 0) +
    (isBold ? 0.22 : 0) +
    (isIsolatedLine ? 0.18 : 0) +
    (labels.has('section_heading') ? 0.15 : 0) +
    (Math.max(yGapAbove, yGapBelow) >= 14 ? 0.10 : 0),
  );

  const signal_score = Math.min(1, [...signalKeys].reduce((sum, s) => sum + SIGNAL_WEIGHT[s], 0));

  const evidenceText = evidence.map(e => e.quote).join(' ').toLowerCase();
  const evidenceTokens = evidenceText.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const termDomainHits = termTokens.filter(t => DOMAIN_TERMS.has(t)).length;
  const evidenceDomainHits = evidenceTokens.filter(t => DOMAIN_TERMS.has(t)).length;
  const domain = Math.min(1, (termDomainHits * 0.6) + Math.min(0.4, evidenceDomainHits * 0.05));
  const recurrence = Math.min(1, Math.log10(1 + mentionCount) / Math.log10(50));
  let phraseQuality: number;
  if (termTokens.length === 0) phraseQuality = 0;
  else if (termTokens.length === 1) phraseQuality = 0.4;
  else if (termTokens.length <= 4) phraseQuality = 1.0;
  else if (termTokens.length <= 6) phraseQuality = 0.5;
  else phraseQuality = 0.2;
  if (isFlaggedReject) phraseQuality *= 0.25;
  const quality_score = Math.min(1, phraseQuality * 0.7 + recurrence * 0.3);
  const context_score = Math.min(1, topicRelevance * 0.55 + domain * 0.30 + (signalKeys.has('definition_pattern') ? 0.15 : 0));
  let final_score = typography_score * 0.25 + signal_score * 0.30 + quality_score * 0.20 + context_score * 0.25;
  if (labels.has('sentence_fragment') || labels.has('caption_or_figure') || labels.has('toc_or_index')) final_score *= 0.35;
  else if (labels.has('low_context')) final_score *= 0.75;

  return {
    typography_score: +typography_score.toFixed(3),
    signal_score: +signal_score.toFixed(3),
    quality_score: +quality_score.toFixed(3),
    context_score: +context_score.toFixed(3),
    final_score: +final_score.toFixed(3),
  };
}

function contextSnippetFor(builder: CandidateBuilder, blocksByOrder: Map<number, SegmentedBlock>, blocksByPage: Map<number, SegmentedBlock[]>): string {
  const firstOrder = [...builder.readingOrders].sort((a, b) => a - b)[0];
  if (firstOrder != null) {
    const pieces: string[] = [];
    for (const offset of [-2, -1, 0, 1, 2]) {
      const b = blocksByOrder.get(firstOrder + offset);
      if (b && b.hint !== 'formula') pieces.push(b.text);
    }
    const joined = pieces.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) return joined.slice(0, 700);
  }
  const page = [...builder.pagesForContext][0];
  const pageBlocks = blocksByPage.get(page) ?? blocksByPage.get(page - 1) ?? blocksByPage.get(page + 1) ?? [];
  return pageBlocks.slice(0, 4).map(b => b.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 700);
}

export function extractCandidates(
  blocks: SegmentedBlock[],
  sectionPaths: Map<number, string[]>,
  topicAnchors: string[] = [],
): CandidateExtractionResult {
  const builders = new Map<string, CandidateBuilder>();
  const relations: RelationCandidate[] = [];
  const misconceptions: Array<{ quote: string; page: number; section_path: string[] }> = [];

  let headingsSeen = 0;
  let definitionsFound = 0;
  const allCapsPhrases = new Map<string, { count: number; firstQuote: string; firstPage: number; firstPath: string[] }>();
  const blocksByOrder = new Map(blocks.map(b => [b.readingOrder, b]));
  const blocksByPage = new Map<number, SegmentedBlock[]>();
  for (const b of blocks) {
    const arr = blocksByPage.get(b.page) ?? [];
    arr.push(b);
    blocksByPage.set(b.page, arr);
  }

  for (const b of blocks) {
    const path = sectionPaths.get(b.readingOrder) ?? [];

    // 1. Heading-derived candidates
    if ((b.hint === 'heading' || b.hint === 'subheading') && b.hintConfidence >= 1) {
      headingsSeen += 1;
      const term = b.text
        .replace(/^#+\s*/, '')                  // markdown heading hashes
        .replace(/^\d+(\.\d+)*\.?\s*/, '')      // leading "3.2" numbering
        .replace(/[:\s]+$/, '')                 // trailing colon/whitespace
        .trim()
        .slice(0, 80);
      // Reject equation-shaped "headings" — these become equation candidates
      // and would otherwise pollute the concept list with formulas.
      if (term.length >= 2 && term.length <= 80 && !looksLikeEquation(term) && !term.startsWith('`')) {
        const builder = ensure(builders, term, path, b.page);
        addSignal(builder, 'heading', b.text, b.page);
        addBlockSignal(builder, b, b.hint === 'heading' ? 'section_heading' : 'weak_heading');
        if (b.signals.fontSizeRatio >= 1.15) builder.labels.add('large_font');
      }
      continue;
    }

    // 2. Bold-block candidates (short isolated bold lines = likely emphasized term)
    if (b.signals.isBold && b.signals.isIsolatedLine && b.text.length <= 80) {
      const builder = ensure(builders, b.text, path, b.page);
      addSignal(builder, 'bold_block', b.text, b.page);
      addBlockSignal(builder, b, 'bold_emphasis');
    }

    // 3. Definition-pattern candidates
    const defs = findDefinitions(b.text);
    definitionsFound += defs.length;
    for (const hit of defs) {
      const builder = ensure(builders, hit.term, path, b.page);
      builder.term = hit.term.trim();
      addSignal(builder, 'definition_pattern', hit.quote, b.page, hit.pattern);
      addBlockSignal(builder, b, 'defined_term');
    }

    // 4. Relation candidates (no candidate-builder side effect; just collected)
    for (const r of findRelations(b.text)) {
      relations.push({ from: r.from, to: r.to, kind: r.kind, quote: r.quote, page: b.page });
    }

    // 5. Misconception phrases
    for (const q of findMisconceptionPhrases(b.text)) {
      misconceptions.push({ quote: q, page: b.page, section_path: path });
    }

    // 6. Capitalized phrases — collect for repetition pass
    for (const phrase of findCapitalizedPhrases(b.text)) {
      const key = normalize(phrase);
      const existing = allCapsPhrases.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        allCapsPhrases.set(key, {
          count: 1,
          firstQuote: phrase,
          firstPage: b.page,
          firstPath: path,
        });
      }
    }
  }

  // Repetition promotion: capitalized phrases above threshold get a candidate
  let repetitionPromoted = 0;
  for (const [key, info] of allCapsPhrases) {
    // Already a candidate via heading/definition/bold? Just add the
    // repetition signal — don't create a duplicate.
    const existing = builders.get(key);
    if (existing) {
      if (info.count >= REPETITION_THRESHOLD) {
        addSignal(existing, 'repetition', `appears ${info.count}×`, info.firstPage);
        existing.labels.add('repeated_term');
      }
      // Always record a low-confidence cap-phrase signal so we can see why
      addSignal(existing, 'capitalized_phrase', info.firstQuote, info.firstPage);
      existing.mention_count = Math.max(existing.mention_count, info.count);
      continue;
    }
    if (info.count >= REPETITION_THRESHOLD) {
      const builder = ensure(builders, info.firstQuote, info.firstPath, info.firstPage);
      addSignal(builder, 'capitalized_phrase', info.firstQuote, info.firstPage);
      addSignal(builder, 'repetition', `appears ${info.count}×`, info.firstPage);
      builder.labels.add('repeated_term');
      builder.mention_count = info.count;
      repetitionPromoted += 1;
    }
  }

  // Build final candidates
  const candidates: ConceptCandidate[] = [...builders.values()].map(b => {
    const confidence = Math.min(
      1,
      [...b.signal_weights.values()].reduce((a, b2) => a + b2, 0),
    );
    const signalKeys = new Set<CandidateSource>(b.signal_weights.keys());

    // Topic relevance — Jaccard-ish against derived anchors. 1.0 when anchors unavailable.
    const evidenceTokens = b.evidence.flatMap(e => tokenize(e.quote)).slice(0, 60);
    const rel = scoreTopicRelevance(tokenize(b.term), evidenceTokens, topicAnchors);

    // Deterministic quality gates
    const reject_reasons: string[] = [];
    const is_boilerplate = isBoilerplateHeading(b.normalized);
    const is_broad       = isBroadTerm(b.term, signalKeys, b.mention_count);
    const fragment       = isFragment(b.term);
    const generic        = isGenericRejected(b.normalized);
    const nameLike       = looksLikeName(b.normalized);
    if (is_boilerplate) reject_reasons.push('boilerplate');
    if (is_broad)       reject_reasons.push('broad');
    if (fragment)       reject_reasons.push('fragment');
    if (generic)        reject_reasons.push('generic');
    if (nameLike)       reject_reasons.push('name');
    if (fragment) b.labels.add('sentence_fragment');
    if (looksLikeCaptionOrFigure(b.term)) {
      reject_reasons.push('caption');
      b.labels.add('caption_or_figure');
    }
    if (looksLikeTocOrIndex(b.term)) {
      reject_reasons.push('toc_or_index');
      b.labels.add('toc_or_index');
    }
    const termTokensForScore = tokensLower(b.term);
    if (rel.score < 0.25 && !signalKeys.has('definition_pattern')) b.labels.add('low_context');
    if (termTokensForScore.some(t => DOMAIN_TERMS.has(t))) b.labels.add('domain_phrase');
    const context_snippet = contextSnippetFor(b, blocksByOrder, blocksByPage);
    if (!context_snippet) b.labels.add('low_context');
    const scoreParts = scoreCandidate(
      signalKeys, b.evidence, b.mention_count,
      termTokensForScore, rel.score, reject_reasons.length > 0, b.typographySignals, b.labels,
    );

    return {
      term: b.term,
      normalized: b.normalized,
      confidence: +confidence.toFixed(2),
      evidence: b.evidence,
      section_path: b.section_path,
      first_page: Math.min(...b.pages),
      mention_count: b.mention_count,
      topic_relevance_score: rel.score,
      topic_relevance_reasons: rel.reasons,
      is_boilerplate,
      is_broad,
      concept_score: scoreParts.final_score,
      ...scoreParts,
      labels: [...b.labels].sort(),
      typography_signals: b.typographySignals,
      context_snippet,
      parser_diagnostics: {
        source_count: b.evidence.length,
        reading_orders: [...b.readingOrders].sort((a, b2) => a - b2).slice(0, 8),
        pages: [...b.pages].sort((a, b2) => a - b2).slice(0, 8),
      },
      reject_reasons,
    };
  });

  // Sort by confidence desc, then mention count desc
  // Sort by deterministic concept_score first (best signal/noise ratio),
  // then confidence as tiebreaker, then mention count.
  candidates.sort((a, b) =>
    (b.final_score ?? 0) - (a.final_score ?? 0) ||
    b.concept_score - a.concept_score ||
    b.confidence - a.confidence ||
    b.mention_count - a.mention_count,
  );

  // Equations: deterministic detection + proximity attach to nearest preceding
  // candidate. Drop any equation whose attached_term isn't actually a candidate
  // we kept (e.g. attached to a rejected equation-shaped "heading").
  const equations = extractEquationsWithSections(blocks, sectionPaths).map(eq => ({
    ...eq,
    attached_term: eq.attached_term ?? equationFallbackTag(eq),
  }));

  return {
    candidates,
    relations,
    misconception_phrases: misconceptions,
    equations,
    diagnostics: {
      blocks_seen: blocks.length,
      headings_seen: headingsSeen,
      definitions_found: definitionsFound,
      capitalized_phrases_unique: allCapsPhrases.size,
      repetition_promoted: repetitionPromoted,
      equations_found: equations.length,
      rejected_headings: candidates.filter(c => c.evidence.some(e => e.source === 'heading') && c.reject_reasons.length > 0).length,
      typography_backed_candidates: candidates.filter(c => (c.typography_score ?? 0) >= 0.5).length,
      fragments: candidates.filter(c => (c.labels ?? []).includes('sentence_fragment')).length,
      toc_index_blocks: candidates.filter(c => (c.labels ?? []).includes('toc_or_index')).length,
      contextless_candidates: candidates.filter(c => (c.labels ?? []).includes('low_context')).length,
      final_score_high: candidates.filter(c => (c.final_score ?? 0) >= 0.8).length,
      final_score_medium: candidates.filter(c => (c.final_score ?? 0) >= 0.55 && (c.final_score ?? 0) < 0.8).length,
      final_score_low: candidates.filter(c => (c.final_score ?? 0) < 0.55).length,
    },
  };
}
