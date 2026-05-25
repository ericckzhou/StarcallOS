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
    };
    map.set(key, b);
  }
  b.pages.add(page);
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

// "From Large Language Models to" → fragment (trailing prep).
// "However Deep Learning"          → fragment (connective prefix).
// "Foo-"                            → fragment (trailing dash).
function isFragment(term: string): boolean {
  const t = term.trim();
  if (!t) return true;
  if (t.endsWith('-')) return true;
  const toks = tokensLower(t);
  if (toks.length === 0) return true;
  if (PROSE_TAIL_WORDS.has(toks[toks.length - 1])) return true;
  if (CONNECTIVE_PREFIXES.has(toks[0])) return true;
  if (toks.length === 1 && (CONNECTIVE_PREFIXES.has(toks[0]) || PROSE_TAIL_WORDS.has(toks[0]))) return true;
  if (PROSE_HEAD_WORDS.has(toks[0]) && toks.length === 1) return true;
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

interface ScoreParts {
  heading: number;
  domain: number;
  localContext: number;
  recurrence: number;
  phraseQuality: number;
}

function scoreCandidate(
  signalKeys: Set<CandidateSource>,
  evidence: EvidenceSpan[],
  mentionCount: number,
  termTokens: string[],
  topicRelevance: number,
  isFlaggedReject: boolean,
): { score: number; parts: ScoreParts } {
  // 1. Heading signal — 0 / 0.5 / 1
  const heading = signalKeys.has('heading') ? 1.0
    : signalKeys.has('bold_block') ? 0.5
    : 0;

  // 2. Domain term presence in term itself OR evidence quotes
  const evidenceText = evidence.map(e => e.quote).join(' ').toLowerCase();
  const evidenceTokens = evidenceText.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const termDomainHits = termTokens.filter(t => DOMAIN_TERMS.has(t)).length;
  const evidenceDomainHits = evidenceTokens.filter(t => DOMAIN_TERMS.has(t)).length;
  const domain = Math.min(1, (termDomainHits * 0.6) + Math.min(0.4, evidenceDomainHits * 0.05));

  // 3. Local context — leverage existing topic relevance score (already 0–1)
  const localContext = topicRelevance;

  // 4. Recurrence — saturating curve based on mention_count
  const recurrence = Math.min(1, Math.log10(1 + mentionCount) / Math.log10(50));

  // 5. Phrase quality — token count 2–4 ideal, single-word penalized,
  //    5+ tokens penalized (sentence fragment risk)
  let phraseQuality: number;
  if (termTokens.length === 0) phraseQuality = 0;
  else if (termTokens.length === 1) phraseQuality = 0.4;
  else if (termTokens.length <= 4) phraseQuality = 1.0;
  else if (termTokens.length <= 6) phraseQuality = 0.5;
  else phraseQuality = 0.2;

  const parts: ScoreParts = { heading, domain, localContext, recurrence, phraseQuality };
  const raw = heading * 0.35 + domain * 0.25 + localContext * 0.20 + recurrence * 0.10 + phraseQuality * 0.10;
  // Hard penalty if the candidate was flagged for rejection (fragment/generic/etc).
  const score = isFlaggedReject ? raw * 0.3 : raw;
  return { score: +score.toFixed(3), parts };
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
      }
      continue;
    }

    // 2. Bold-block candidates (short isolated bold lines = likely emphasized term)
    if (b.signals.isBold && b.signals.isIsolatedLine && b.text.length <= 80) {
      const builder = ensure(builders, b.text, path, b.page);
      addSignal(builder, 'bold_block', b.text, b.page);
    }

    // 3. Definition-pattern candidates
    const defs = findDefinitions(b.text);
    definitionsFound += defs.length;
    for (const hit of defs) {
      const builder = ensure(builders, hit.term, path, b.page);
      addSignal(builder, 'definition_pattern', hit.quote, b.page, hit.pattern);
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

    const termTokensForScore = tokensLower(b.term);
    const { score } = scoreCandidate(
      signalKeys, b.evidence, b.mention_count,
      termTokensForScore, rel.score, reject_reasons.length > 0,
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
      concept_score: score,
      reject_reasons,
    };
  });

  // Sort by confidence desc, then mention count desc
  // Sort by deterministic concept_score first (best signal/noise ratio),
  // then confidence as tiebreaker, then mention count.
  candidates.sort((a, b) =>
    b.concept_score - a.concept_score ||
    b.confidence - a.confidence ||
    b.mention_count - a.mention_count,
  );

  // Equations: deterministic detection + proximity attach to nearest preceding
  // candidate. Drop any equation whose attached_term isn't actually a candidate
  // we kept (e.g. attached to a rejected equation-shaped "heading").
  const knownNormalized = new Set(candidates.map(c => c.normalized));
  const equations = extractEquationsWithSections(blocks, sectionPaths).map(eq => ({
    ...eq,
    attached_term: eq.attached_term && knownNormalized.has(eq.attached_term) ? eq.attached_term : null,
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
    },
  };
}
