// Hybrid chunk retrieval (RAG foundation, PR 1): SQLite FTS5 BM25 + cosine over
// the existing local embedding vectors, fused with Reciprocal Rank Fusion.
// No LLM is involved; the only model call is embedding the query, and only in
// vector/hybrid mode with an embedder supplied. Every function is deterministic
// for a fixed index: ties break on chunk id.
//
// Degradation is explicit, never silent: when vectors are unavailable (no
// embedder, server unreachable, or no chunk vectors indexed for the model) a
// hybrid request falls back to keyword-only and the result says so in
// `mode_used` + `vector_error`. A vector-only request returns no hits plus the
// same error.

import type { DatabaseSync } from '../core/infra/sqlite';
import { cosine, type Embedder } from '../core/embeddings';
import { getChunksByIds, loadChunkVectors, queryEmbeddingText } from './repos/rag_chunks';

export type RetrievalMode = 'keyword' | 'vector' | 'hybrid';

export interface RankedHit {
  chunkId: number;
  score: number;   // retriever-native: BM25 relevance (higher = better) or cosine similarity
  rank: number;    // 1-based
}

export interface FusedHit {
  chunkId: number;
  score: number;                 // RRF score
  ranks: Array<number | null>;   // per input list, 1-based rank or null if absent
}

export interface RetrievalOptions {
  query: string;
  mode?: RetrievalMode;          // default 'hybrid'
  k?: number;                    // results returned (default 8)
  sourceIds?: number[];          // document / collection filter; omitted = all sources
  candidatePool?: number;        // per-retriever depth fed to RRF (default 50)
  rrfK?: number;                 // RRF constant (default 60, Cormack et al. 2009)
  minSimilarity?: number;        // vector hits below this cosine are dropped (default 0)
  embedder?: Embedder | null;
}

export interface RetrievedChunk {
  chunk_id: number;
  chunk_key: string;
  source_id: number;
  source_title: string;
  text: string;
  heading: string | null;
  section_path: string[];
  page_start: number;
  page_end: number;
  has_formula: boolean;
  score: number;                     // score in the mode used (RRF / BM25 / cosine)
  keyword_rank: number | null;
  keyword_score: number | null;      // -bm25, higher = more relevant
  vector_rank: number | null;
  vector_similarity: number | null;
}

export interface RetrievalResult {
  query: string;
  mode_requested: RetrievalMode;
  mode_used: RetrievalMode;
  vector_error: string | null;
  keyword_query: string | null;      // the FTS5 MATCH expression actually run
  hits: RetrievedChunk[];
}

// Function words that only add BM25 noise in an OR query. Deliberately small:
// domain words ("set", "order", "power") must survive.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'is', 'are', 'was', 'were', 'be',
  'been', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
  'where', 'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'from', 'as', 'at', 'about', 'into',
  'than', 'then', 'there', 'their', 'between', 'if', 'we', 'you', 'i', 'me', 'my', 'our', 'your', 'explain',
  'describe', 'tell', 'give', 'mean', 'means', 'meant',
]);

// Build a safe FTS5 MATCH expression: unicode word tokens, stopwords removed,
// each token double-quoted (so FTS operators/punctuation in the user's text
// can never become syntax), OR-combined so BM25 ranks partial matches.
// Returns null when nothing searchable remains.
export function buildFtsQuery(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(t => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return null;
  return uniq.map(t => `"${t}"`).join(' OR ');
}

function sourceFilter(sourceIds?: number[]): { sql: string; args: number[] } {
  if (!sourceIds || sourceIds.length === 0) return { sql: '', args: [] };
  return { sql: `AND c.source_id IN (${sourceIds.map(() => '?').join(',')})`, args: sourceIds };
}

// BM25 over chunk text (weight 1.0) and section path (weight 0.5).
export function keywordSearch(
  db: DatabaseSync,
  query: string,
  opts: { sourceIds?: number[]; limit?: number } = {},
): RankedHit[] {
  const match = buildFtsQuery(query);
  if (!match) return [];
  const f = sourceFilter(opts.sourceIds);
  const rows = db.prepare(
    `SELECT c.id AS id, bm25(rag_chunks_fts, 1.0, 0.5) AS s
       FROM rag_chunks_fts
       JOIN rag_chunks c ON c.id = rag_chunks_fts.rowid
      WHERE rag_chunks_fts MATCH ? ${f.sql}
      ORDER BY s ASC, c.id ASC
      LIMIT ?`,
  ).all(match, ...f.args, opts.limit ?? 50) as Array<{ id: number; s: number }>;
  return rows.map((r, i) => ({ chunkId: Number(r.id), score: -Number(r.s), rank: i + 1 }));
}

export class VectorUnavailableError extends Error {}

// Cosine over stored chunk vectors. Throws VectorUnavailableError when there is
// nothing to search (no vectors for this model in scope) or the query cannot be
// embedded — callers decide how to degrade.
export async function vectorSearch(
  db: DatabaseSync,
  embedder: Embedder,
  query: string,
  opts: { sourceIds?: number[]; limit?: number; minSimilarity?: number } = {},
): Promise<RankedHit[]> {
  const vectors = loadChunkVectors(db, embedder.model, opts.sourceIds);
  if (vectors.length === 0) {
    throw new VectorUnavailableError(`No chunk embeddings indexed for model "${embedder.model}" in the selected sources.`);
  }
  if (!query.trim()) return [];
  let q: Float32Array;
  try {
    [q] = await embedder.embed([queryEmbeddingText(embedder.model, query)]);
  } catch (e) {
    throw new VectorUnavailableError(`Query embedding failed: ${(e as Error).message}`);
  }
  const min = opts.minSimilarity ?? 0;
  return vectors
    .map(v => ({ chunkId: v.chunkId, score: cosine(q, v.vec) }))
    .filter(h => h.score >= min)
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
    .slice(0, opts.limit ?? 50)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}

// Reciprocal Rank Fusion: score(d) = Σ 1 / (rrfK + rank_i(d)). Ties break on
// the best single-list rank, then chunk id, so output is fully deterministic.
export function reciprocalRankFusion(lists: RankedHit[][], rrfK = 60, limit = Infinity): FusedHit[] {
  const acc = new Map<number, FusedHit>();
  lists.forEach((list, li) => {
    for (const h of list) {
      let f = acc.get(h.chunkId);
      if (!f) {
        f = { chunkId: h.chunkId, score: 0, ranks: lists.map(() => null) };
        acc.set(h.chunkId, f);
      }
      f.score += 1 / (rrfK + h.rank);
      f.ranks[li] = h.rank;
    }
  });
  const best = (f: FusedHit) => Math.min(...f.ranks.map(r => r ?? Infinity));
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || best(a) - best(b) || a.chunkId - b.chunkId)
    .slice(0, limit);
}

export async function retrieveChunks(db: DatabaseSync, opts: RetrievalOptions): Promise<RetrievalResult> {
  const mode = opts.mode ?? 'hybrid';
  const k = opts.k ?? 8;
  const pool = Math.max(opts.candidatePool ?? 50, k);
  const base = { query: opts.query, mode_requested: mode, keyword_query: buildFtsQuery(opts.query) };

  let keyword: RankedHit[] = [];
  let vector: RankedHit[] = [];
  let vectorError: string | null = null;

  if (mode !== 'vector') keyword = keywordSearch(db, opts.query, { sourceIds: opts.sourceIds, limit: pool });
  if (mode !== 'keyword') {
    if (!opts.embedder) {
      vectorError = 'Embeddings are not configured.';
    } else {
      try {
        vector = await vectorSearch(db, opts.embedder, opts.query, {
          sourceIds: opts.sourceIds, limit: pool, minSimilarity: opts.minSimilarity,
        });
      } catch (e) {
        if (!(e instanceof VectorUnavailableError)) throw e;
        vectorError = e.message;
      }
    }
  }

  let modeUsed: RetrievalMode = mode;
  let ranked: Array<{ chunkId: number; score: number }>;
  if (mode === 'keyword') {
    ranked = keyword.slice(0, k);
  } else if (mode === 'vector') {
    ranked = vector.slice(0, k);
  } else if (vectorError) {
    modeUsed = 'keyword';
    ranked = keyword.slice(0, k);
  } else {
    ranked = reciprocalRankFusion([keyword, vector], opts.rrfK ?? 60, k);
  }

  const kw = new Map(keyword.map(h => [h.chunkId, h]));
  const vc = new Map(vector.map(h => [h.chunkId, h]));
  const chunks = new Map(getChunksByIds(db, ranked.map(r => r.chunkId)).map(c => [c.id, c]));
  const titles = new Map<number, string>();
  const titleOf = (sourceId: number): string => {
    if (!titles.has(sourceId)) {
      const r = db.prepare(`SELECT COALESCE(title, filename) AS t FROM sources WHERE id = ?`).get(sourceId) as { t?: string } | undefined;
      titles.set(sourceId, r?.t ?? '');
    }
    return titles.get(sourceId)!;
  };

  const hits: RetrievedChunk[] = [];
  for (const r of ranked) {
    const c = chunks.get(r.chunkId);
    if (!c) continue;
    hits.push({
      chunk_id: c.id, chunk_key: c.chunk_key, source_id: c.source_id, source_title: titleOf(c.source_id),
      text: c.text, heading: c.heading, section_path: c.section_path,
      page_start: c.page_start, page_end: c.page_end, has_formula: c.has_formula,
      score: r.score,
      keyword_rank: kw.get(c.id)?.rank ?? null, keyword_score: kw.get(c.id)?.score ?? null,
      vector_rank: vc.get(c.id)?.rank ?? null, vector_similarity: vc.get(c.id)?.score ?? null,
    });
  }
  return { ...base, mode_used: modeUsed, vector_error: vectorError, hits };
}
