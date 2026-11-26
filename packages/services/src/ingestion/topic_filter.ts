// Candidate topic-fit filter: prompt builder + response parser. Pure; moved out
// of Electron main so the eval harness can exercise the exact production prompt.
// Contract: ../../../../contracts/topic_filter.md

export interface TopicFilterCandidate {
  normalized: string;
}

export interface TopicFilterDecision {
  term: string;
  keep: boolean;
  reason?: string;
}

// Pull the JSON object out of a model/ChatGPT reply: strips ``` fences and any
// prose before the first `{` / after the last `}`.
export function extractJsonObject(raw: string): string {
  let body = raw.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  return body;
}

// Compact prompt: one term per line (no per-candidate JSON, no context snippet —
// the term + book title is enough signal for topic-fit, and dropping ctx roughly
// halves input tokens so far more candidates fit per call). Output is a keep-list
// (just the terms to keep) which is much smaller than a per-candidate decision.
export function buildCandidateLlmFilterPrompt(sourceTitle: string | undefined, candidates: TopicFilterCandidate[]): string {
  const title = sourceTitle || '(unknown source title)';
  const lines = candidates.map(c => c.normalized).join('\n');
  return [
    `Filter candidate concepts extracted from a book.`,
    `Book title: "${title}"`,
    ``,
    `Keep only terms a reader would specifically study for THIS book's subject.`,
    `Reject broad/generic words, boilerplate, captions, fragments, TOC/index leftovers, and off-topic terms.`,
    ``,
    `Candidate terms (one per line):`,
    lines,
    ``,
    `Respond ONLY with compact JSON listing the terms to KEEP, copied exactly:`,
    `{"keep":["<term>", ...]}`,
  ].join('\n');
}

// Accepts the new keep-list form {"keep":[...]} (preferred) and the legacy
// per-candidate {"decisions":[{term,keep}]} form (manual ChatGPT paste path).
export function parseCandidateLlmFilterResponse(raw: string): TopicFilterDecision[] {
  const parsed = JSON.parse(extractJsonObject(raw)) as { keep?: unknown; decisions?: unknown };
  if (Array.isArray(parsed.keep)) {
    return parsed.keep
      .filter((t): t is string => typeof t === 'string')
      .map(term => ({ term, keep: true }));
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('LLM response did not include a keep or decisions array.');
  }
  return parsed.decisions
    .map((d): TopicFilterDecision | null => {
      if (!d || typeof d !== 'object') return null;
      const obj = d as { term?: unknown; keep?: unknown; reason?: unknown };
      if (typeof obj.term !== 'string' || typeof obj.keep !== 'boolean') return null;
      return {
        term: obj.term,
        keep: obj.keep,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      };
    })
    .filter((d): d is TopicFilterDecision => d !== null);
}

// Match key for a returned term against the batch's normalized terms: case-,
// edge- and inner-whitespace-insensitive (models pad or re-space terms).
export function topicFilterKey(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Kept terms from a batch's decisions, as the batch's own keys. Terms the
// batch didn't send (hallucinated or stale) are dropped; duplicates collapse.
export function keptBatchTerms(batch: TopicFilterCandidate[], decisions: TopicFilterDecision[]): string[] {
  const sent = new Set(batch.map(c => topicFilterKey(c.normalized)));
  const out = new Set<string>();
  for (const d of decisions) {
    const key = topicFilterKey(d.term);
    if (d.keep && sent.has(key)) out.add(key);
  }
  return [...out];
}
