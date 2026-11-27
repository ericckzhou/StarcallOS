import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { normalize, type Embedder } from '../core/embeddings';
import type { BlockHint, SegmentedBlock } from '../ingestion/layout';
import { chunkBlocks } from '../ingestion/chunker';
import { createSource } from './repos/sources';
import { indexSourceChunkEmbeddings, listSourceChunks, syncSourceChunks } from './repos/rag_chunks';
import { buildFtsQuery, keywordSearch, reciprocalRankFusion, retrieveChunks, vectorSearch, type RankedHit } from './retrieval';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}

// Topic-vector fake: each chunk/query maps onto a few concept axes, so "vector"
// can find paraphrases that share no keyword with the chunk.
const AXES: Array<[string, RegExp]> = [
  ['induction', /induction|inductive|domino/i],
  ['search', /binary search|halv|bisect|sorted array/i],
  ['regex', /regular expression|kleene|regex|pattern/i],
  ['graph', /tree|graph|edge|node/i],
];
function topicEmbedder(model = 'topic'): Embedder & { calls: number } {
  const e = {
    model, calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map(t => normalize(Float32Array.from([...AXES.map(([, re]) => (re.test(t) ? 1 : 0)), 0.05])));
    },
  };
  return e;
}

function seed() {
  const db = openDb(':memory:');
  const a = createSource(db, { filename: 'b36.pdf', file_path: 'b36.pdf', title: 'B36 notes' });
  const b = createSource(db, { filename: 'algo.pdf', file_path: 'algo.pdf', title: 'Algorithms' });
  order = 0;
  syncSourceChunks(db, a.id, chunkBlocks([
    blk('Induction', 1, 'heading'),
    blk('Mathematical induction proves P(n) for all n by a basis case and an induction step.', 1),
    blk('Trees', 2, 'heading'),
    blk('A binary tree with n nodes has n − 1 edges; every node except the root has one parent edge.', 2),
    blk('Regular expressions', 3, 'heading'),
    blk('The Kleene star of a language L is the set of all concatenations of zero or more strings of L.', 3),
  ]).chunks);
  order = 0;
  syncSourceChunks(db, b.id, chunkBlocks([
    blk('Binary search', 1, 'heading'),
    blk('Binary search repeatedly halves a sorted array until the key is found or the interval is empty.', 1),
  ]).chunks);
  return { db, a, b };
}

describe('buildFtsQuery', () => {
  it('quotes word tokens, drops stopwords and neutralizes FTS syntax', () => {
    expect(buildFtsQuery('What is the Kleene star?')).toBe('"kleene" OR "star"');
    expect(buildFtsQuery('NEAR(ab cd) "xy" AND -zz*')).toBe('"near" OR "ab" OR "cd" OR "xy" OR "zz"');
    // Single-letter variables are too unselective for BM25; digits survive.
    expect(buildFtsQuery('P(n) for n = 3')).toBe('"3"');
    expect(buildFtsQuery('what is the')).toBeNull();
    expect(buildFtsQuery('')).toBeNull();
  });
});

describe('keywordSearch', () => {
  it('ranks by BM25 with stable ordering and porter stemming', () => {
    const { db } = seed();
    const hits = keywordSearch(db, 'how are edges counted in trees');
    expect(hits.length).toBeGreaterThan(0);
    const top = listSourceChunks(db, 1).find(c => c.heading === 'Trees')!;
    expect(hits[0].chunkId).toBe(top.id);
    expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i + 1));
    expect(keywordSearch(db, 'how are edges counted in trees')).toEqual(hits);
  });

  it('matches the section path, filters by source and handles hostile input', () => {
    const { db, a, b } = seed();
    expect(keywordSearch(db, 'binary', { sourceIds: [b.id] }).every(h => h.chunkId === listSourceChunks(db, b.id)[0].id)).toBe(true);
    expect(keywordSearch(db, 'halves sorted array', { sourceIds: [a.id] })).toEqual([]);
    expect(keywordSearch(db, '"); DROP TABLE rag_chunks; --')).toEqual([]);
    expect(keywordSearch(db, 'regular', { limit: 1 })).toHaveLength(1);
  });
});

describe('vectorSearch', () => {
  it('finds a paraphrase that shares no keyword and breaks ties by chunk id', async () => {
    const { db, a, b } = seed();
    const emb = topicEmbedder();
    await indexSourceChunkEmbeddings(db, emb, a.id);
    await indexSourceChunkEmbeddings(db, emb, b.id);
    const hits = await vectorSearch(db, emb, 'bisect it');
    expect(hits[0].chunkId).toBe(listSourceChunks(db, b.id)[0].id);
    expect(keywordSearch(db, 'bisect it')).toEqual([]);
    // Ties: equal similarity ordered by ascending chunk id.
    const ties = await vectorSearch(db, emb, 'nothing relevant');
    for (let i = 1; i < ties.length; i++) {
      if (ties[i].score === ties[i - 1].score) expect(ties[i].chunkId).toBeGreaterThan(ties[i - 1].chunkId);
    }
  });

  it('applies minSimilarity and the source filter', async () => {
    const { db, a } = seed();
    const emb = topicEmbedder();
    await indexSourceChunkEmbeddings(db, emb, a.id);
    const hits = await vectorSearch(db, emb, 'kleene star pattern', { minSimilarity: 0.5, sourceIds: [a.id] });
    expect(hits).toHaveLength(1);
  });
});

describe('reciprocalRankFusion', () => {
  const list = (...ids: number[]): RankedHit[] => ids.map((chunkId, i) => ({ chunkId, score: 1, rank: i + 1 }));
  it('sums 1/(k + rank) across lists', () => {
    const fused = reciprocalRankFusion([list(1, 2, 3), list(3, 1)], 60);
    expect(fused.map(f => f.chunkId)).toEqual([1, 3, 2]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused[0].ranks).toEqual([1, 2]);
    expect(fused[2].ranks).toEqual([2, null]);
  });
  it('breaks score ties by best single rank, then chunk id', () => {
    expect(reciprocalRankFusion([list(5, 9), list(9, 5)]).map(f => f.chunkId)).toEqual([5, 9]);
    expect(reciprocalRankFusion([list(8), list(4)]).map(f => f.chunkId)).toEqual([4, 8]);
  });
  it('respects the limit and handles empty input', () => {
    expect(reciprocalRankFusion([list(1, 2, 3)], 60, 2)).toHaveLength(2);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('retrieveChunks', () => {
  it('hybrid fuses keyword and vector hits and returns source metadata', async () => {
    const { db, a, b } = seed();
    const emb = topicEmbedder();
    await indexSourceChunkEmbeddings(db, emb, a.id);
    await indexSourceChunkEmbeddings(db, emb, b.id);
    const r = await retrieveChunks(db, { query: 'bisect a sorted list', embedder: emb, k: 3 });
    expect(r.mode_used).toBe('hybrid');
    expect(r.vector_error).toBeNull();
    expect(r.hits[0]).toMatchObject({ source_title: 'Algorithms', page_start: 1, section_path: ['Binary search'] });
    expect(r.hits[0].vector_rank).toBe(1);
    expect(r.hits[0].keyword_rank).toBe(1);
  });

  it('falls back to keyword-only, explicitly, when embeddings are unavailable', async () => {
    const { db } = seed();
    const none = await retrieveChunks(db, { query: 'kleene star', embedder: null });
    expect(none.mode_used).toBe('keyword');
    expect(none.vector_error).toMatch(/not configured/);
    expect(none.hits[0].heading).toBe('Regular expressions');

    const notIndexed = await retrieveChunks(db, { query: 'kleene star', embedder: topicEmbedder() });
    expect(notIndexed.mode_used).toBe('keyword');
    expect(notIndexed.vector_error).toMatch(/No chunk embeddings indexed/);

    const down: Embedder = { model: 'topic', async embed() { throw new Error('unreachable'); } };
    await indexSourceChunkEmbeddings(db, topicEmbedder(), 1);
    const broken = await retrieveChunks(db, { query: 'kleene star', embedder: down });
    expect(broken.mode_used).toBe('keyword');
    expect(broken.vector_error).toMatch(/Query embedding failed: unreachable/);

    const vecOnly = await retrieveChunks(db, { query: 'kleene', mode: 'vector', embedder: null });
    expect(vecOnly.hits).toEqual([]);
    expect(vecOnly.vector_error).not.toBeNull();
  });

  it('is deterministic across repeated queries and never mixes in another model\'s vectors', async () => {
    const { db, a, b } = seed();
    await indexSourceChunkEmbeddings(db, topicEmbedder(), a.id);
    await indexSourceChunkEmbeddings(db, topicEmbedder(), b.id);
    const q = { query: 'halving a sorted array', embedder: topicEmbedder(), k: 4 };
    const first = await retrieveChunks(db, q);
    const second = await retrieveChunks(db, q);
    expect(second.hits.map(h => [h.chunk_id, h.score])).toEqual(first.hits.map(h => [h.chunk_id, h.score]));
    expect(first.mode_used).toBe('hybrid');
    // Vectors exist only under model "topic": a different model sees none and says so.
    const other = await retrieveChunks(db, { ...q, embedder: topicEmbedder('other-model') });
    expect(other.mode_used).toBe('keyword');
    expect(other.vector_error).toMatch(/No chunk embeddings indexed for model "other-model"/);
  });

  it('keyword mode never calls the embedder', async () => {
    const { db } = seed();
    const emb = topicEmbedder();
    await retrieveChunks(db, { query: 'induction', mode: 'keyword', embedder: emb });
    expect(emb.calls).toBe(0);
  });

  it('honours k and the source filter', async () => {
    const { db, a } = seed();
    const r = await retrieveChunks(db, { query: 'binary tree search nodes', mode: 'keyword', k: 1, sourceIds: [a.id] });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].source_id).toBe(a.id);
  });
});
