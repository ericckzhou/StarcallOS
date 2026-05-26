// Deterministic pattern matchers for definitions, relationships, and emphasis.
// Each matcher returns the candidate term plus the sentence that proves it —
// no judgement, just evidence. Downstream code decides what's worth promoting.

export interface PatternHit {
  term: string;
  quote: string;
  pattern: string;
}

// ─── Definition patterns ──────────────────────────────────────────────────────
// Capture "X is defined as Y" and close variants. The term is whatever comes
// before the connecting phrase; the quote is the whole matched sentence.

interface DefRule {
  name: string;
  // Capturing group 1 is the term. The match must cover the full sentence
  // up to its terminal punctuation for the quote.
  re: RegExp;
}

const DEFINITION_RULES: DefRule[] = [
  { name: 'is_defined_as',  re: /([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})\s+(?:is|are|was|were)\s+defined\s+as\s+[^.!?]+[.!?]/g },
  { name: 'refers_to',      re: /([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})\s+refers\s+to\s+[^.!?]+[.!?]/g },
  { name: 'is_a',           re: /([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})\s+(?:is|are)\s+(?:a|an|the)\s+(?:type|kind|form|class|instance|special\s+case)\s+of\s+[^.!?]+[.!?]/g },
  { name: 'consists_of',    re: /([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})\s+(?:consists?\s+of|is\s+composed\s+of|is\s+made\s+up\s+of)\s+[^.!?]+[.!?]/g },
  { name: 'known_as',       re: /(?:known|referred\s+to)\s+as\s+([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})[^.!?]*[.!?]/g },
  { name: 'we_call',        re: /(?:we|one|you)\s+(?:call|term|name)\s+(?:this|it|them|these)\s+([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})[^.!?]*[.!?]/g },
  { name: 'colon_def',      re: /^([A-Z][\w-]*(?:\s+[A-Z]?[\w-]*){0,4})\s*:\s+[A-Z][^.!?]{20,}[.!?]/gm },
];

export function findDefinitions(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const rule of DEFINITION_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const term = m[1]?.trim();
      if (!term || term.length < 2 || term.length > 60) continue;
      hits.push({ term, quote: m[0].trim(), pattern: rule.name });
    }
  }
  return hits;
}

// ─── Relationship patterns ────────────────────────────────────────────────────
// Capture "X requires Y", "X causes Y" — used by deterministic edge builder.

export type RelationKind = 'requires' | 'causes' | 'enables' | 'contrasts_with' | 'example_of';

export interface RelationHit {
  from: string;
  to: string;
  kind: RelationKind;
  quote: string;
}

interface RelRule {
  kind: RelationKind;
  re: RegExp;
}

const RELATION_RULES: RelRule[] = [
  { kind: 'requires',       re: /([A-Z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s+(?:requires?|depends?\s+on|needs?|presupposes?)\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})[^.!?]*[.!?]/g },
  { kind: 'causes',         re: /([A-Z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s+(?:causes?|produces?|leads\s+to|results?\s+in)\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})[^.!?]*[.!?]/g },
  { kind: 'enables',        re: /([A-Z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s+(?:enables?|allows?|makes\s+(?:it\s+)?possible)\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})[^.!?]*[.!?]/g },
  { kind: 'contrasts_with', re: /(?:unlike|in\s+contrast\s+to|as\s+opposed\s+to)\s+([A-Z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s*,\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})[^.!?]*[.!?]/gi },
  { kind: 'example_of',     re: /([A-Z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s+is\s+an?\s+example\s+of\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})[^.!?]*[.!?]/g },
];

export function findRelations(text: string): RelationHit[] {
  const hits: RelationHit[] = [];
  for (const rule of RELATION_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const from = m[1]?.trim();
      const to = m[2]?.trim();
      if (!from || !to || from.length < 2 || to.length < 2) continue;
      if (from.length > 60 || to.length > 60) continue;
      hits.push({ from, to, kind: rule.kind, quote: m[0].trim() });
    }
  }
  return hits;
}

// ─── Misconception phrases ────────────────────────────────────────────────────
// Textbook authors flag misconceptions explicitly. Capture them verbatim
// for the misconception extractor downstream.

const MISCONCEPTION_RES: RegExp[] = [
  /(?:common\s+(?:mistake|misconception|error|pitfall)s?|a\s+frequent\s+confusion|students?\s+often\s+(?:think|believe|assume))[:\s][^.!?]+[.!?]/gi,
  /(?:do\s+not\s+confuse|don't\s+confuse|should\s+not\s+be\s+confused\s+with)\s+[^.!?]+[.!?]/gi,
  /(?:contrary\s+to\s+(?:popular\s+)?(?:belief|intuition))[^.!?]+[.!?]/gi,
  /(?:beware|warning|caution|note\s+that)\s*[:\s][^.!?]{20,}[.!?]/gi,
];

export function findMisconceptionPhrases(text: string): string[] {
  const out: string[] = [];
  for (const re of MISCONCEPTION_RES) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) out.push(m[0].trim());
  }
  return out;
}

// ─── Capitalized noun phrases ─────────────────────────────────────────────────
// Multi-word capitalized terms are strong candidates in technical writing.
// E.g., "Backpropagation Through Time", "Long Short-Term Memory".

const STOPWORDS = new Set([
  'The','A','An','This','That','These','Those','It','They','We','You','I',
  'In','On','At','By','For','With','From','To','Of','And','Or','But','If',
  'Is','Are','Was','Were','Be','Been','Being','Have','Has','Had',
  'Do','Does','Did','Can','Could','Will','Would','Shall','Should','May','Might','Must',
  'When','Where','Why','How','What','Which','Who','Whom','Whose',
  'Figure','Table','Equation','Section','Chapter','Page','Note',
]);

export function findCapitalizedPhrases(text: string): string[] {
  // Sequences of 1–4 capitalized words, optionally containing lowercase
  // connectors ("of", "the") between them. Filter pure stopwords.
  const re = /\b([A-Z][a-zA-Z]+(?:[-–\s](?:of\s+|the\s+)?[A-Z][a-zA-Z]+){0,3})\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1].trim().replace(/\s+/g, ' ');
    if (phrase.length < 3 || phrase.length > 60) continue;
    const words = phrase.split(/\s+/);
    if (words.length === 1 && STOPWORDS.has(words[0])) continue;
    if (words.every(w => STOPWORDS.has(w))) continue;
    out.add(phrase);
  }
  return [...out];
}
