// Deterministic equation detector. Equations are evidence — they get
// attached to the nearest preceding concept candidate by reading order.
//
// Detection heuristics (no LLM):
//   - LaTeX command density: contains `\command`, `\frac`, `\sum`, Greek letters
//   - Math operator density: `=`, `+`, `-`, `^`, `_`, `{`, `}`
//   - Display math markdown: `$$...$$` or single `$...$` spans
//   - Low ratio of plain words to math characters

import type { SegmentedBlock } from './layout';

export interface EquationCandidate {
  latex: string;
  variables: string[];
  page: number;
  reading_order: number;
  section_path: string[];
  attached_term: string | null;  // normalized term key, filled by attach pass
}

const LATEX_CMD     = /\\[a-zA-Z]+/g;
const GREEK         = /[αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]/;
const MATH_OPS      = /[=+\-*/^_{}<>≤≥≈≠∑∫∂∇√×·]/g;
const DISPLAY_MATH  = /^\$\$[\s\S]+\$\$$/;
const INLINE_MATH   = /\$[^$]+\$/g;
const CODE_FENCE    = /^`{3,}/;
const VAR_TOKEN     = /\\[a-zA-Z]+|[a-zA-Z](?:_\{?[a-zA-Z0-9]+\}?)?/g;

const ALPHA = /[a-zA-Z]/g;

// Currency words / formats that make a $...$ span definitely NOT math.
const CURRENCY_WORDS = /\b(?:million|billion|trillion|thousand|hundred|dollars?|usd|eur|gbp|cents?|cad|aud|jpy)\b/i;
const CURRENCY_NUMBER = /^[\s\d.,$+\-]+$/; // pure currency-ish: digits, commas, dots, signs

// A $...$ span counts as inline math only if its interior actually contains
// math markers. Filters out currency runs like "$320 million ... $60 million".
function isRealInlineMath(span: string): boolean {
  // Strip leading/trailing $
  const inner = span.replace(/^\$|\$$/g, '');
  if (!inner.trim()) return false;
  // Reject obvious currency content
  if (CURRENCY_WORDS.test(inner)) return false;
  if (CURRENCY_NUMBER.test(inner)) return false;
  // Require at least one true math marker
  if (/\\[a-zA-Z]/.test(inner)) return true;          // LaTeX command
  if (GREEK.test(inner)) return true;
  if (/[=^_{}]/.test(inner)) return true;             // assignment, sub/superscript
  if (/[a-zA-Z]\s*[+\-*/]\s*[a-zA-Z0-9]/.test(inner)) return true; // var op var
  return false;
}

export function looksLikeEquation(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3) return false;
  if (CODE_FENCE.test(t)) return false;          // code fence delimiters
  if (DISPLAY_MATH.test(t)) return true;
  if (t.startsWith('\\') && /\\[a-zA-Z]/.test(t)) return true;

  const latexCmds = (t.match(LATEX_CMD) ?? []).length;
  const mathOps   = (t.match(MATH_OPS) ?? []).length;
  const alphaLen  = (t.match(ALPHA) ?? []).length;
  const total     = t.length;

  // Heavy LaTeX presence
  if (latexCmds >= 2) return true;

  // Inline-math markdown — must contain actual math markers, not currency.
  const inlineMatches = t.match(INLINE_MATH) ?? [];
  const realInline = inlineMatches.filter(isRealInlineMath);
  if (realInline.length >= 1 && t.length < 200) return true;

  // Math-dense: lots of ops, an `=`, few words
  if (t.includes('=') && mathOps >= 3 && alphaLen / Math.max(total, 1) < 0.45) return true;

  // Greek-letter dominated short expression
  if (GREEK.test(t) && total < 80 && mathOps >= 1) return true;

  return false;
}

function extractVariables(latex: string): string[] {
  const tokens = latex.match(VAR_TOKEN) ?? [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    // Drop common LaTeX layout/formatting commands — they're not variables.
    if (/^\\(?:frac|sum|int|cdot|times|left|right|mathrm|mathbf|mathit|text|begin|end|sqrt|partial|nabla|infty|to|in|leq|geq|neq|approx|alpha|beta|gamma|delta|theta|eta|lambda|mu|sigma|pi|phi|psi|omega)$/i.test(t)) continue;
    if (t.length === 1 && /[+\-*/=^_{}<>]/.test(t)) continue;
    if (seen.size >= 12) break;
    seen.add(t);
  }
  return [...seen];
}

function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
}

// Strip markdown/numbering noise the same way candidates.ts does for headings.
function headingTermFromBlock(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/^\d+(\.\d+)*\.?\s*/, '')
    .replace(/[:\s]+$/, '')
    .trim()
    .slice(0, 80);
}

export function extractEquations(blocks: SegmentedBlock[]): EquationCandidate[] {
  const out: EquationCandidate[] = [];

  // Track the most recent heading-like term so equations can attach.
  let currentHeadingNormalized: string | null = null;

  for (const b of blocks) {
    const isHeading = (b.hint === 'heading' || b.hint === 'subheading') && b.hintConfidence >= 1;
    const isFormulaHint = b.hint === 'formula';
    const eqShaped = looksLikeEquation(b.text);

    // Equation-shaped lines may have been mis-hinted as headings by the markdown
    // pass (short line, no terminal period). Capture them as equations instead
    // of letting them clobber the current heading tracker.
    if (isHeading && !eqShaped) {
      const term = headingTermFromBlock(b.text);
      if (term) currentHeadingNormalized = normalizeTerm(term) || null;
      continue;
    }

    if (!isFormulaHint && !eqShaped) continue;

    // Strip list-item markers so the stored LaTeX is the equation itself,
    // not "* ( \nabla L ) = ...".
    const latex = b.text.trim().replace(/^[*\-]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!latex) continue;

    out.push({
      latex,
      variables: extractVariables(b.text),
      page: b.page,
      reading_order: b.readingOrder,
      section_path: [],            // filled by extractCandidates with sectionPaths map
      attached_term: currentHeadingNormalized,
    });
  }

  return out;
}

// Variant that accepts the same sectionPaths map extractCandidates uses,
// so equation rows carry the proper section breadcrumb.
export function extractEquationsWithSections(
  blocks: SegmentedBlock[],
  sectionPaths: Map<number, string[]>,
): EquationCandidate[] {
  const raw = extractEquations(blocks);
  for (const eq of raw) {
    eq.section_path = sectionPaths.get(eq.reading_order) ?? [];
  }
  return raw;
}
