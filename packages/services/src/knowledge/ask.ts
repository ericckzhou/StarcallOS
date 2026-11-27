// Local question answering over the retrieval chunk index (RAG PR 2).
//
//   question -> retrieveChunks (hybrid, explicit keyword fallback)
//            -> numbered passages -> ONE structured `ask` call to the LOCAL model
//            -> citation validation against the passage text
//
// Guarantees:
// - Source text only goes to the local OpenAI-compatible server
//   (`resolveAskConfig` never returns a cloud provider).
// - No passages => no model call ('no_passages').
// - Every citation must quote its passage verbatim (after whitespace/quote/dash/
//   PDF-glyph normalization) and carries the verified span of the passage. Unverifiable citations are dropped and counted, and the
//   answer's [n] markers are rewritten to match, so a marker the user sees
//   always points at a quote that really is in that passage.
// - Every sentence of the answer is checked for a surviving marker
//   (`analyzeClaims`). An uncited sentence, or a cited one that shares few
//   content words with the passage it cites, keeps the answer out of
//   'grounded'.
// - The model being offline / returning bad output never loses the retrieval:
//   the result degrades to 'retrieval_only' with `generation_error` set.
//
// What is NOT guaranteed: that a cited passage semantically SUPPORTS the
// sentence citing it. A verbatim quote proves the quote exists; the lexical
// overlap check only catches citations that are obviously unrelated. No
// entailment check runs (see ASK_VERIFICATION), and the UI says so.

import { z } from 'zod';
import type { DatabaseSync } from '../core/infra/sqlite';
import type { ProviderConfig } from '../core/llm';
import type { Embedder } from '../core/embeddings';
import { chatStructured } from '../core/structured';
import { retrieveChunks, type RetrievalMode, type RetrievedChunk } from './retrieval';
import { getNextChunksInSection } from './repos/rag_chunks';

// Status names are persisted (ask_history) and scored by the Ask eval, so they
// are kept; their meaning is what the comments say, nothing stronger.
export type AnswerStatus =
  | 'grounded'        // every claim sentence cites a passage with a verbatim-verified
                      // quote, nothing was dropped, and no claim was flagged low-overlap.
                      // NOT a claim that the passages entail the answer.
  | 'partial'         // some support verified, but a citation was dropped, a sentence
                      // is uncited, or a sentence shares few words with what it cites
  | 'qualified'       // the model flagged the passages as insufficient but still gave a
                      // hedged answer with verified citations (e.g. "they give bounds,
                      // not a closed form", or a refuted false premise)
  | 'unsupported'     // the model answered but nothing it cited could be verified
  | 'insufficient'    // the model said the passages do not answer the question
  | 'no_passages'     // retrieval found nothing; no model call made
  | 'retrieval_only'; // generation failed (offline / invalid output); passages only

export interface AskPassage {
  n: number;                 // 1-based number used in the prompt and answer markers
  chunk_id: number;
  source_id: number;
  source_title: string;
  text: string;
  section_path: string[];
  page_start: number;
  page_end: number;
  score: number;
}

export interface AnswerCitation {
  n: number;                 // passage number
  chunk_id: number;
  source_id: number;
  page_start: number;
  page_end: number;
  quote: string;             // as written by the model (verified)
  start: number;             // verified span in the passage text (original offsets)
  end: number;
}

export interface DroppedCitation {
  n: number | null;
  quote: string;
  reason: 'unknown_passage' | 'quote_not_found' | 'quote_too_short' | 'marker_without_quote';
}

// One sentence of the answer and what backs it.
export interface AnswerClaim {
  text: string;              // the sentence, markers included (rewritten answer)
  cited: number[];           // verified passage numbers its markers point at
  // Share of the sentence's content words found in the cited passages
  // (crude stemming). A heuristic for "obviously unrelated", not entailment.
  // null when uncited or the sentence has too few content words to judge.
  overlap: number | null;
  issue: 'uncited' | 'low_overlap' | null;
  // True when the answer had no markers at all and is a single sentence, so
  // every verified citation was attached to it (the only unambiguous reading).
  implicit?: boolean;
}

// What the checks behind a status do and do not establish. Constant; carried
// on every result so the limitation is part of the data, not just the UI copy.
export const ASK_VERIFICATION = {
  // Bump when a change alters which answers get which status. 1 = quote-only
  // (pre claim coverage; results without this object); 2 = per-sentence
  // claim coverage + elision-piece minimum. Eval baselines record it and
  // refuse to compare across versions.
  version: 2,
  quotes: 'verbatim',               // each kept quote occurs in its passage (normalized)
  claim_citations: 'per_sentence',    // each sentence needs a marker to a verified passage
  claim_support: 'lexical_overlap',   // heuristic: flags sentences sharing few words with their passage
  entailment: 'not_checked',          // no check that the passage actually supports the sentence
} as const;
export type AskVerification = typeof ASK_VERIFICATION;

export interface AskResult {
  question: string;
  status: AnswerStatus;
  answer: string | null;     // markers rewritten to verified passages only
  citations: AnswerCitation[];
  dropped: DroppedCitation[];
  // Per-sentence coverage of `answer`. Optional: absent on results saved to
  // Ask history before it existed, and empty when there is no answer.
  claims?: AnswerClaim[];
  verification?: AskVerification;
  passages: AskPassage[];
  retrieval: { mode_requested: RetrievalMode; mode_used: RetrievalMode; vector_error: string | null };
  generation_error: string | null;
  model: string | null;
  // Set by the caller when lazy chunk embedding failed, so vector coverage of
  // the selected sources may be partial even though hybrid retrieval ran.
  index_warning?: string | null;
  // Concept the question was asked about (retrieval focus only), if any.
  focus?: string | null;
  // Set when the result was saved to a concept's Ask history.
  history_id?: number | null;
}

export interface AskOptions {
  question: string;
  sourceIds?: number[];
  config: ProviderConfig | null;   // null => generation unavailable (retrieval only)
  embedder?: Embedder | null;
  k?: number;                      // passages sent to the model (default 6)
  maxPassageChars?: number;        // per-passage cap in the prompt (default 1600)
  // Concept name to bias RETRIEVAL toward (appended to the search query unless
  // the question already contains it). Never added to the model prompt, so it
  // cannot change what counts as a verified citation.
  focus?: string | null;
  // Neighbor expansion (opt-in, default off): spend NEIGHBOR_ANCHORS of the k
  // slots on the passage that follows each of the top hits in the same section.
  neighbors?: boolean;
}

// Measured on the retrieval golden set at the same 6-passage budget: top-4 +
// the in-section follower of the top-2 raised recall of labelled passages
// from 0.715 to 0.756 overall and 0.604 to 0.750 on multi-passage questions,
// with no category lower. End to end (Ask eval, qwen3.5:4b) it improved
// citation precision (.522 -> .556) and dropped citations (.140 -> .096) but
// turned two false-premise answers back into declines (supported .962 ->
// .885), so it stays OFF until re-measured on human-reviewed labels.
// Diversity heuristics (per-section caps, skipping adjacent chunks) lowered
// recall and were not kept.
export const NEIGHBOR_ANCHORS = 2;

export function retrievalQuery(question: string, focus?: string | null): string {
  const f = focus?.trim();
  if (!f) return question;
  return normalizeForQuote(question).includes(normalizeForQuote(f)) ? question : `${question} ${f}`;
}

export const ASK_SYSTEM = `You answer a learner's question using ONLY the numbered source passages provided.

Rules:
- Use only facts stated in the passages. Do not add outside knowledge, even if you are confident.
- After each sentence that states a fact, add the passage number(s) it comes from in square brackets, e.g. [2] or [1, 3].
- For every passage you cite, add an entry to "citations" with a SHORT quote (one phrase or sentence, max ~200 characters) copied EXACTLY, character for character, from that passage. Do not paraphrase quotes.
- If the passages do not contain the answer, set "insufficient" to true and briefly say what is missing. Do not guess.
- Be concise: a few sentences, plain prose. Keep any formulas as they appear in the passages.

Return JSON only: {"answer": string, "citations": [{"passage": number, "quote": string}], "insufficient": boolean}`;

export const AskOutputSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({
    passage: z.number().int(),
    quote: z.string(),
  })).default([]),
  insufficient: z.boolean().default(false),
});
export type AskOutput = z.infer<typeof AskOutputSchema>;

// Quotes below this many normalized characters can match almost anywhere.
export const MIN_QUOTE_CHARS = 12;

// Glyphs PDF text layers commonly emit for the "same" character the model
// writes (TeX fonts map epsilon to U+01EB, etc.). NFKC already folds ϵ/ϕ/ligatures.
const FOLD: Record<string, string> = {
  'ǫ': 'ε', 'Ǫ': 'ε',
  // One class for every quote mark: models swap 'x' for “x” freely, and
  // folding both sides identically keeps apostrophes matching themselves.
  "'": '"', '‘': '"', '’': '"', '‚': '"', '‛': '"', '′': '"', '`': '"',
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '∗': '*', '­': '',
};

// Case-, whitespace-, quote-, dash- and glyph-insensitive form used for
// verification. `map[i]` is the offset in `s` of normalized char i, so a match
// can be reported as a span of the ORIGINAL text.
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (/\s/u.test(ch)) {
      pendingSpace = text.length > 0;
      i += ch.length;
      continue;
    }
    if (pendingSpace) { text += ' '; map.push(i); pendingSpace = false; }
    const folded = [...ch.normalize('NFKC').toLowerCase()].map(c => FOLD[c] ?? c).join('');
    // Join letter-hyphen-letter ("con-\ncatenation", "well-known") on BOTH
    // sides of the comparison, so a PDF line-break hyphen matches the joined
    // word and a real compound still matches itself. "x - y" is untouched.
    if (folded === '-' && /\p{L}$/u.test(text)) {
      let j = i + ch.length;
      let newline = false;
      while (j < s.length && /\s/.test(s[j])) { if (s[j] === '\n') newline = true; j++; }
      if (j < s.length && /\p{L}/u.test(s[j]) && (j === i + ch.length || newline)) { i = j; continue; }
    }
    for (const c of folded) { text += c; map.push(i); }
    i += ch.length;
  }
  return { text, map };
}

export function normalizeForQuote(s: string): string {
  return normalizeWithMap(s).text;
}

export type QuoteCheck =
  | { ok: true; start: number; end: number }   // span in the passage text
  | { ok: false; reason: 'quote_not_found' | 'quote_too_short' };

// A quote is verified when, after normalization, it occurs in the passage. The
// model may elide with "..." / "…": each piece must then occur, in order, and
// the reported span runs from the first piece to the end of the last. Each
// piece must reach MIN_QUOTE_CHARS on its own: otherwise "the ... of ... and
// ... is" strings tiny fragments together and "verifies" against almost any
// passage.
export function quoteInPassage(quote: string, passage: string): QuoteCheck {
  const hay = normalizeWithMap(passage);
  const pieces = normalizeForQuote(quote)
    .replace(/^"+|"+$/g, '')
    .split(/\s*\.\.\.\s*/)
    .map(p => p.replace(/^[\s.,;:]+|[\s.,;:]+$/g, ''))
    .filter(p => p.length > 0);
  if (pieces.length === 0 || pieces.some(p => p.length < MIN_QUOTE_CHARS)) return { ok: false, reason: 'quote_too_short' };
  let from = 0;
  let first = -1;
  for (const p of pieces) {
    const at = hay.text.indexOf(p, from);
    if (at < 0) return { ok: false, reason: 'quote_not_found' };
    if (first < 0) first = at;
    from = at + p.length;
  }
  const lastChar = hay.map[from - 1];
  const end = lastChar + String.fromCodePoint(passage.codePointAt(lastChar)!).length;
  return { ok: true, start: hay.map[first], end };
}

const MARKER_RE = /\s?\[(\d+(?:\s*,\s*\d+)*)\]/g;

// Keep only markers that point at a verified passage; drop the rest (and the
// whole bracket when nothing in it survives).
export function rewriteMarkers(answer: string, verified: Set<number>): { text: string; droppedMarkers: number[] } {
  const droppedMarkers: number[] = [];
  const text = answer.replace(MARKER_RE, (whole, list: string) => {
    const nums = list.split(',').map(x => Number(x.trim()));
    const keep = nums.filter(n => verified.has(n));
    for (const n of nums) if (!verified.has(n)) droppedMarkers.push(n);
    if (keep.length === 0) return '';
    const lead = whole.startsWith(' ') ? ' ' : '';
    return `${lead}[${[...new Set(keep)].join(', ')}]`;
  });
  return { text: text.replace(/[ \t]+([.,;:!?])/g, '$1').trim(), droppedMarkers };
}

export function markersIn(answer: string): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(MARKER_RE)) {
    for (const x of m[1].split(',')) out.push(Number(x.trim()));
  }
  return out;
}

// ─── claim coverage ─────────────────────────────────────────────────────────

// Sentences shorter than this many words ("Yes.", "In short:") are not treated
// as claims that need their own citation.
export const MIN_CLAIM_WORDS = 3;
// A cited sentence with at least MIN_OVERLAP_TOKENS content words, fewer than
// this share of which occur in its cited passages, is flagged 'low_overlap'.
// Chosen a priori as "most of the sentence's key words are absent"; NOT tuned
// on the Ask eval set. Paraphrase legitimately lowers overlap, which is why it
// is a flag that withholds 'grounded', never a reason to drop a citation.
export const LOW_OVERLAP = 0.5;
const MIN_OVERLAP_TOKENS = 2;

const CLAIM_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'not', 'no', 'nor', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'how', 'why', 'when', 'where', 'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
  'shall', 'from', 'as', 'at', 'about', 'into', 'than', 'then', 'there', 'their', 'they', 'them', 'if', 'so', 'such',
  'also', 'only', 'very', 'has', 'have', 'had', 'any', 'all', 'each', 'every', 'some', 'more', 'most', 'other', 'one',
  'we', 'you', 'i', 'he', 'she', 'his', 'her', 'our', 'your', 'us', 'yes', 'here', 'thus', 'hence', 'therefore',
  'passage', 'passages', 'source', 'sources', 'text', 'states', 'stated', 'says', 'according', 'mentions', 'mentioned',
]);

function stem(t: string): string {
  for (const suf of ['ing', 'ed', 'es', 'ly', 's']) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

// Content tokens: normalized (same folding as quote checks), stopwords and
// single letters (variable names) removed, numbers kept, crudely stemmed.
export function contentTokens(s: string): string[] {
  const words = normalizeForQuote(s.replace(MARKER_RE, ' ')).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter(w => !CLAIM_STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w))).map(stem);
}

// Split an answer into sentences. A sentence ends at . ! ? (plus any closing
// quote/bracket and trailing [n] markers) followed by whitespace and a capital,
// digit, quote or bracket, or at a newline, so "e.g. the", "3.14" and
// "P(n). [1]" stay intact. Offsets index into `answer`.
export function splitClaims(answer: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const push = (s: number, e: number) => {
    const raw = answer.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ text, start: s + lead, end: s + lead + text.length });
  };
  const END = /[.!?]+["'”’)\]]*(?:\s*\[\d+(?:\s*,\s*\d+)*\])*(?=\s+["“(\[]?[\p{Lu}\p{N}]|\s*$)|\n+/gu;
  let at = 0;
  for (const m of answer.matchAll(END)) {
    const e = m.index! + m[0].length;
    push(at, e);
    at = e;
  }
  push(at, answer.length);
  return out;
}

// Pure: which sentences of the (marker-rewritten) answer carry a verified
// citation, and how much of each cited sentence's vocabulary its passages share.
//
// Small local models often list verified quotes but write no [n] markers. A
// one-sentence answer with no markers gets every verified citation attached
// (`implicit`), since there is nothing else they could belong to; it still
// faces the overlap check. In a longer unmarked answer the association is
// unknowable, so every sentence stays 'uncited'.
export function analyzeClaims(answer: string, passages: AskPassage[], verified: Set<number>): AnswerClaim[] {
  const byN = new Map(passages.map(p => [p.n, p]));
  const tokenCache = new Map<number, string[]>();
  const passageTokens = (n: number) => {
    if (!tokenCache.has(n)) tokenCache.set(n, contentTokens(byN.get(n)?.text ?? ''));
    return tokenCache.get(n)!;
  };
  const sentences = splitClaims(answer).map(s => s.text).filter(text =>
    (text.replace(MARKER_RE, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length >= MIN_CLAIM_WORDS);
  const implicit = sentences.length === 1 && markersIn(answer).length === 0 && verified.size > 0;
  const claims: AnswerClaim[] = [];
  for (const text of sentences) {
    const cited = implicit ? [...verified].sort((a, b) => a - b) : [...new Set(markersIn(text).filter(n => verified.has(n)))];
    if (cited.length === 0) { claims.push({ text, cited, overlap: null, issue: 'uncited' }); continue; }
    const extra = implicit ? { implicit: true } : {};
    const mine = [...new Set(contentTokens(text))];
    if (mine.length < MIN_OVERLAP_TOKENS) { claims.push({ text, cited, overlap: null, issue: null, ...extra }); continue; }
    const theirs = cited.flatMap(passageTokens);
    const have = new Set(theirs);
    // A shared 6-character prefix absorbs suffixes the crude stemmer misses
    // ("inductive" / "induction").
    const prefixes = new Set(theirs.filter(p => p.length >= 6).map(p => p.slice(0, 6)));
    const found = mine.filter(t => have.has(t) || (t.length >= 6 && prefixes.has(t.slice(0, 6))));
    const overlap = Math.round((found.length / mine.length) * 1000) / 1000;
    claims.push({ text, cited, overlap, issue: overlap < LOW_OVERLAP ? 'low_overlap' : null, ...extra });
  }
  return claims;
}

// Pure: validate the model's output against the passages it was shown.
export function validateAnswer(out: AskOutput, passages: AskPassage[]): {
  status: Exclude<AnswerStatus, 'no_passages' | 'retrieval_only'>;
  answer: string;
  citations: AnswerCitation[];
  dropped: DroppedCitation[];
  claims: AnswerClaim[];
} {
  const byN = new Map(passages.map(p => [p.n, p]));
  const citations: AnswerCitation[] = [];
  const dropped: DroppedCitation[] = [];
  const seen = new Set<string>();

  for (const c of out.citations) {
    const p = byN.get(c.passage);
    if (!p) { dropped.push({ n: c.passage, quote: c.quote, reason: 'unknown_passage' }); continue; }
    const v = quoteInPassage(c.quote, p.text);
    if (!v.ok) { dropped.push({ n: c.passage, quote: c.quote, reason: v.reason }); continue; }
    const key = `${p.n}|${normalizeForQuote(c.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      n: p.n, chunk_id: p.chunk_id, source_id: p.source_id,
      page_start: p.page_start, page_end: p.page_end, quote: c.quote.trim(), start: v.start, end: v.end,
    });
  }

  const verified = new Set(citations.map(c => c.n));
  const { text, droppedMarkers } = rewriteMarkers(out.answer, verified);
  for (const n of [...new Set(droppedMarkers)]) {
    // Already reported when the citation itself failed; only add markers that
    // never had a quote at all.
    if (!dropped.some(d => d.n === n)) dropped.push({ n, quote: '', reason: 'marker_without_quote' });
  }

  const claims = analyzeClaims(text, passages, verified);

  let status: Exclude<AnswerStatus, 'no_passages' | 'retrieval_only'>;
  // A hedged answer that still cites verified passages is shown as a caveated
  // answer, not a decline: it tells the learner what the sources DO say.
  if (out.insufficient) status = citations.length > 0 ? 'qualified' : 'insufficient';
  else if (citations.length === 0) status = 'unsupported';
  // Verified quotes exist; an uncited sentence (including an unmarked
  // multi-sentence answer, where no quote is tied to any sentence) makes it
  // 'partial', never 'grounded'.
  else if (dropped.length > 0 || claims.some(c => c.issue !== null)) status = 'partial';
  // Too short to have claim sentences ("Yes.") and no marker either.
  else if (claims.length === 0 && markersIn(text).length === 0) status = 'partial';
  else status = 'grounded';
  return { status, answer: text, citations, dropped, claims };
}

// Choose the k passages to send: the top k - NEIGHBOR_ANCHORS hits, each of
// the top NEIGHBOR_ANCHORS followed directly by its in-section follower (so
// the model reads them contiguously), then remaining hits to fill k. A
// follower that is already a top hit keeps its own rank.
export function withNeighbors(db: DatabaseSync, hits: RetrievedChunk[], k: number): RetrievedChunk[] {
  const anchors = k >= 4 ? Math.min(NEIGHBOR_ANCHORS, hits.length) : 0;
  if (anchors === 0) return hits.slice(0, k);
  const base = hits.slice(0, k - anchors);
  const next = getNextChunksInSection(db, hits.slice(0, anchors).map(h => h.chunk_id));
  const chosen = new Set<number>();
  const out: RetrievedChunk[] = [];
  const push = (c: RetrievedChunk) => { if (!chosen.has(c.chunk_id) && out.length < k) { chosen.add(c.chunk_id); out.push(c); } };
  const baseIds = new Set(base.map(h => h.chunk_id));
  base.forEach((h, i) => {
    push(h);
    const n = i < anchors ? next.get(h.chunk_id) : undefined;
    if (n && !baseIds.has(n.id)) {
      push({
        ...h, chunk_id: n.id, chunk_key: n.chunk_key, text: n.text, heading: n.heading, section_path: n.section_path,
        page_start: n.page_start, page_end: n.page_end, has_formula: n.has_formula,
        keyword_rank: null, keyword_score: null, vector_rank: null, vector_similarity: null,
      });
    }
  });
  for (const h of hits) push(h);
  return out;
}

export function toPassages(hits: RetrievedChunk[]): AskPassage[] {
  return hits.map((h, i) => ({
    n: i + 1, chunk_id: h.chunk_id, source_id: h.source_id, source_title: h.source_title,
    text: h.text, section_path: h.section_path, page_start: h.page_start, page_end: h.page_end, score: h.score,
  }));
}

export function buildAskUserPrompt(question: string, passages: AskPassage[], maxChars = 1600): string {
  const blocks = passages.map(p => {
    const where = [
      p.source_title,
      p.section_path.length ? p.section_path.join(' > ') : null,
      p.page_start === p.page_end ? `p. ${p.page_start}` : `pp. ${p.page_start}-${p.page_end}`,
    ].filter(Boolean).join(' | ');
    const body = p.text.length > maxChars ? `${p.text.slice(0, maxChars)}…` : p.text;
    return `[${p.n}] (${where})\n${body}`;
  });
  return `Passages:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question.trim()}`;
}

export async function askSources(db: DatabaseSync, opts: AskOptions): Promise<AskResult> {
  const question = opts.question.trim();
  const k = opts.k ?? 6;
  const retrieval = await retrieveChunks(db, {
    query: retrievalQuery(question, opts.focus), mode: 'hybrid', k, sourceIds: opts.sourceIds, embedder: opts.embedder ?? null,
  });
  const passages = toPassages(opts.neighbors ? withNeighbors(db, retrieval.hits, k) : retrieval.hits);
  const base = {
    question,
    passages,
    retrieval: { mode_requested: retrieval.mode_requested, mode_used: retrieval.mode_used, vector_error: retrieval.vector_error },
    model: opts.config?.model ?? null,
    focus: opts.focus?.trim() || null,
    claims: [] as AnswerClaim[],
    verification: ASK_VERIFICATION,
  };

  if (passages.length === 0) {
    return { ...base, status: 'no_passages', answer: null, citations: [], dropped: [], generation_error: null };
  }
  if (!opts.config) {
    return {
      ...base, status: 'retrieval_only', answer: null, citations: [], dropped: [],
      generation_error: 'No local model is configured.',
    };
  }

  // The prompt-truncated passage text is what the model saw, so quotes are
  // verified against that same text.
  const maxChars = opts.maxPassageChars ?? 1600;
  const shown = passages.map(p => (p.text.length > maxChars ? { ...p, text: p.text.slice(0, maxChars) } : p));
  try {
    const { data } = await chatStructured(
      opts.config,
      {
        messages: [
          { role: 'system', content: ASK_SYSTEM },
          { role: 'user', content: buildAskUserPrompt(question, passages, maxChars) },
        ],
        temperature: 0,
        maxTokens: 1024,
      },
      'ask',
      { schema: AskOutputSchema, name: 'answer_with_citations' },
    );
    const v = validateAnswer(data, shown);
    // Small models sometimes put the bare word "insufficient" in `answer`;
    // that is a flag, not an explanation — let the UI show its own message.
    const trivial = v.status === 'insufficient' && /^[\W_]*(insufficient|n\/?a|none)?[\W_]*$/i.test(v.answer);
    return {
      ...base, status: v.status, answer: trivial ? null : v.answer, citations: v.citations, dropped: v.dropped,
      claims: trivial ? [] : v.claims, generation_error: null,
    };
  } catch (e) {
    return {
      ...base, status: 'retrieval_only', answer: null, citations: [], dropped: [],
      generation_error: e instanceof Error ? e.message : String(e),
    };
  }
}
