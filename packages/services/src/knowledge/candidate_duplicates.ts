// Near-duplicate hints for concept candidates (opt-in embeddings). Flags pairs
// like "gradient descent" / "gradient descent algorithm" or "eigenvalue" /
// "eigenvalues" that the exact normalized-term dedupe cannot see. Hints only: Candidate Review shows a chip; nothing is merged,
// rejected, or promoted automatically.

import { cosine, textHash, type Embedder } from '../core/embeddings';

// Calibrated on nomic-embed-text with the "clustering:" prefix: true
// duplicates ("eigenvalue"/"eigenvalues", "gradient descent"/"gradient descent
// algorithm") score 0.95–0.99; related-but-distinct terms ("gradient descent"
// / "stochastic gradient descent") ~0.91. Abbreviations ("GD update rule")
// are out of reach for term embeddings.
export const NEAR_DUPLICATE_THRESHOLD = 0.93;

export interface DuplicateCandidateInput {
  id: number;
  term: string;
  normalized: string;
}

export interface NearDuplicate {
  id: number;          // the OTHER candidate
  term: string;
  similarity: number;
}

// Term only: differing evidence quotes pull true duplicates apart. nomic
// models expect a task prefix for symmetric similarity.
function candidateText(c: DuplicateCandidateInput, model: string): string {
  return /nomic/i.test(model) ? `clustering: ${c.term}` : c.term;
}

// Best near-duplicate per candidate (symmetric), excluding identical
// normalized terms (already deduped elsewhere). O(n²) dot products over a few
// hundred candidates — negligible next to the embedding calls.
export async function findCandidateNearDuplicates(
  embedder: Embedder,
  candidates: DuplicateCandidateInput[],
  threshold = NEAR_DUPLICATE_THRESHOLD,
): Promise<Record<number, NearDuplicate>> {
  if (candidates.length < 2) return {};
  const vecs = await embedder.embed(candidates.map(c => candidateText(c, embedder.model)));
  const best: Record<number, NearDuplicate> = {};
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.normalized.toLowerCase() === b.normalized.toLowerCase()) continue;
      const sim = cosine(vecs[i], vecs[j]);
      if (sim < threshold) continue;
      if (!best[a.id] || sim > best[a.id].similarity) best[a.id] = { id: b.id, term: b.term, similarity: sim };
      if (!best[b.id] || sim > best[b.id].similarity) best[b.id] = { id: a.id, term: a.term, similarity: sim };
    }
  }
  return best;
}

// Process-lifetime memo in front of an embedder, keyed by model + text hash,
// so re-opening Candidate Review does not re-embed unchanged terms. Bounded:
// the oldest entries are evicted past `max`.
export function createCachingEmbedder(inner: Embedder, max = 20_000): Embedder {
  const cache = new Map<string, Float32Array>();
  return {
    model: inner.model,
    baseUrl: inner.baseUrl,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const keys = texts.map(t => `${inner.model}|${textHash(t)}`);
      const missing = [...new Set(keys.filter(k => !cache.has(k)))];
      if (missing.length > 0) {
        const textByKey = new Map(keys.map((k, i) => [k, texts[i]]));
        const vecs = await inner.embed(missing.map(k => textByKey.get(k)!));
        missing.forEach((k, i) => cache.set(k, vecs[i]));
        while (cache.size > max) cache.delete(cache.keys().next().value!);
      }
      return keys.map(k => cache.get(k)!);
    },
  };
}
