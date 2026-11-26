import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { normalize, type Embedder } from '../core/embeddings';
import type { BlockHint, SegmentedBlock } from '../ingestion/layout';
import { chunkBlocks } from '../ingestion/chunker';
import { createSource } from './repos/sources';
import { indexSourceChunkEmbeddings, syncSourceChunks } from './repos/rag_chunks';
import { searchSourcePassages } from './source_search';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}

// Topic-vector fake: paraphrases share an axis without sharing a keyword.
const AXES = [/induction|domino/i, /tree|graph|edge/i, /kleene|regular expression|pattern/i];
function topicEmbedder(): Embedder {
  return {
    model: 'topic',
    async embed(texts: string[]) {
      return texts.map(t => normalize(Float32Array.from([...AXES.map(re => (re.test(t) ? 1 : 0)), 0.05])));
    },
  };
}
const downEmbedder: Embedder = { model: 'topic', async embed() { throw new Error('ECONNREFUSED'); } };

function seed() {
  const db = openDb(':memory:');
  const src = createSource(db, { filename: 'b36.pdf', file_path: 'b36.pdf', title: 'B36' });
  const other = createSource(db, { filename: 'x.pdf', file_path: 'x.pdf', title: 'X' });
  order = 0;
  syncSourceChunks(db, src.id, chunkBlocks([
    blk('Induction', 1, 'heading'),
    blk('Mathematical induction proves P(n) for all n by a basis case and an induction step.', 1),
    blk('Trees', 4, 'heading'),
    blk('A binary tree with n nodes has n − 1 edges; every node except the root has one parent edge.', 4),
    blk('Regular expressions', 7, 'heading'),
    blk('The Kleene star of a language L is the set of all concatenations of zero or more strings of L.', 7),
  ]).chunks);
  order = 0;
  syncSourceChunks(db, other.id, chunkBlocks([blk('Domino chains topple one after another forever.', 1)]).chunks);
  return { db, src, other };
}

describe('searchSourcePassages', () => {
  it('finds a paraphrase by meaning, scoped to the source, one hit per page', async () => {
    const { db, src } = seed();
    const embedder = topicEmbedder();
    await indexSourceChunkEmbeddings(db, embedder, src.id);
    const r = await searchSourcePassages(db, src.id, 'falling domino argument', embedder);
    expect(r.mode_used).toBe('hybrid');
    expect(r.note).toBeNull();
    expect(r.hits[0].page).toBe(1);                       // induction, no shared keyword
    expect(new Set(r.hits.map(h => h.page)).size).toBe(r.hits.length);
    expect(r.hits.every(h => h.snippet.length <= 181)).toBe(true);
  });

  it('falls back to keyword with a note when passages are not embedded', async () => {
    const { db, src } = seed();
    const r = await searchSourcePassages(db, src.id, 'kleene star', topicEmbedder());
    expect(r.mode_used).toBe('keyword');
    expect(r.note).toMatch(/not embedded/);
    expect(r.hits[0].page).toBe(7);
  });

  it('falls back to keyword when embeddings are off or the server is down', async () => {
    const { db, src } = seed();
    expect((await searchSourcePassages(db, src.id, 'binary tree edges', null)).note).toMatch(/Embeddings are off/);
    await indexSourceChunkEmbeddings(db, topicEmbedder(), src.id);
    const r = await searchSourcePassages(db, src.id, 'binary tree edges', downEmbedder);
    expect(r.mode_used).toBe('keyword');
    expect(r.note).toMatch(/unavailable/);
    expect(r.hits[0].page).toBe(4);
  });

  it('explains an unindexed source instead of returning silently empty', async () => {
    const { db } = seed();
    const bare = createSource(db, { filename: 'new.pdf', file_path: 'new.pdf', title: 'New' });
    const r = await searchSourcePassages(db, bare.id, 'anything', topicEmbedder());
    expect(r.hits).toEqual([]);
    expect(r.note).toMatch(/no passage index/);
  });
});
