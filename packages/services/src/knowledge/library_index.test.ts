import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { normalize, type Embedder } from '../core/embeddings';
import { CHUNKER_VERSION, LAYOUT_VERSION } from '../core/version';
import type { BlockHint, SegmentedBlock } from '../ingestion/layout';
import { chunkBlocks } from '../ingestion/chunker';
import { createSource } from './repos/sources';
import { syncSourceChunks } from './repos/rag_chunks';
import { planLibraryIndex, runLibraryIndex } from './library_index';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}
function drafts(topic: string) {
  order = 0;
  return chunkBlocks([
    blk(topic, 1, 'heading'),
    blk(`${topic} is explained here with enough words to form a real retrieval chunk of text.`, 1),
  ]).chunks;
}

function countingEmbedder(fail = false): Embedder & { texts: number } {
  const e = {
    model: 'm', texts: 0,
    async embed(texts: string[]) {
      if (fail) throw new Error('Embedding server at http://127.0.0.1:9/v1 could not be reached.');
      e.texts += texts.length;
      return texts.map(() => normalize(Float32Array.from([1, 0.5])));
    },
  };
  return e;
}

// a: never chunked (small) · b: chunked by an older layout · c: current, no vectors
function seed() {
  const db = openDb(':memory:');
  const a = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf', title: 'A' });
  const b = createSource(db, { filename: 'b.pdf', file_path: 'b.pdf', title: 'B' });
  const c = createSource(db, { filename: 'c.pdf', file_path: 'c.pdf', title: 'C' });
  syncSourceChunks(db, b.id, drafts('Graphs'), { chunker: CHUNKER_VERSION, layout: '0.5.2' });
  syncSourceChunks(db, c.id, drafts('Trees'));
  const rebuilt: number[] = [];
  const rebuildChunks = async (id: number) => {
    rebuilt.push(id);
    syncSourceChunks(db, id, drafts(id === a.id ? 'Induction' : 'Graphs'));
  };
  return { db, a, b, c, rebuilt, rebuildChunks };
}

describe('planLibraryIndex', () => {
  it('orders unindexed, then stale, then embed-only', () => {
    const { db, a, b, c } = seed();
    const p = planLibraryIndex(db, { embeddingModel: 'm' });
    expect(p.items.map(i => [i.source_id, i.action])).toEqual([[a.id, 'chunk'], [b.id, 'rechunk'], [c.id, null]]);
    expect(p).toMatchObject({ sources: 3, unindexed: 1, stale: 1, done: false });
    expect(p.items[2].embed_missing).toBe(1);
  });

  it('uses the per-source expected layout (PDF parser choice)', () => {
    const { db, b, c } = seed();
    // Docling selected: c (built-in stamp) becomes stale; b stays stale.
    const p = planLibraryIndex(db, { embeddingModel: null, expectLayout: s => (s.file_path === 'c.pdf' || s.file_path === 'b.pdf' ? 'docling-0.1.0' : LAYOUT_VERSION) });
    expect(p.items.find(i => i.source_id === c.id)?.action).toBe('rechunk');
    expect(p.items.find(i => i.source_id === b.id)?.action).toBe('rechunk');
    syncSourceChunks(db, c.id, drafts('Trees'), { chunker: CHUNKER_VERSION, layout: 'docling-0.1.0' });
    const p2 = planLibraryIndex(db, { embeddingModel: null, expectLayout: () => 'docling-0.1.0' });
    expect(p2.items.find(i => i.source_id === c.id)?.action).toBeNull();
  });

  it('with embeddings off, a current source needs nothing', () => {
    const { db, c } = seed();
    const p = planLibraryIndex(db, { embeddingModel: null });
    expect(p.items.find(i => i.source_id === c.id)).toMatchObject({ action: null, embed_missing: 0 });
    expect(p.embed_missing).toBe(0);
  });
});

describe('runLibraryIndex', () => {
  it('chunks, re-chunks and embeds everything; a second run does nothing', async () => {
    const { db, a, b, rebuilt, rebuildChunks } = seed();
    const embedder = countingEmbedder();
    const s1 = await runLibraryIndex(db, { rebuildChunks, embedder });
    expect(rebuilt).toEqual([a.id, b.id]);
    expect(s1).toMatchObject({ stopped: false, chunked: 1, rechunked: 1, embedded_chunks: 3, failures: [], embed_error: null });
    expect(planLibraryIndex(db, { embeddingModel: 'm' }).done).toBe(true);

    const before = embedder.texts;
    const s2 = await runLibraryIndex(db, { rebuildChunks, embedder });
    expect(s2.sources_processed).toBe(0);
    expect(embedder.texts).toBe(before);
    expect(rebuilt).toEqual([a.id, b.id]);
  });

  it('records a failing source and keeps going', async () => {
    const { db, a, b, c, rebuildChunks } = seed();
    const s = await runLibraryIndex(db, {
      embedder: countingEmbedder(),
      rebuildChunks: async id => { if (id === a.id) throw new Error('source file no longer exists'); await rebuildChunks(id); },
    });
    expect(s.failures).toEqual([{ source_id: a.id, title: 'A', stage: 'chunk', error: 'source file no longer exists' }]);
    expect(s.rechunked).toBe(1);
    const p = planLibraryIndex(db, { embeddingModel: 'm' });
    expect(p.items.filter(i => i.action || i.embed_missing).map(i => i.source_id)).toEqual([a.id]);
    expect([b.id, c.id].every(id => p.items.find(i => i.source_id === id)!.embed_missing === 0)).toBe(true);
  });

  it('stops between sources and resumes without redoing finished work', async () => {
    const { db, a, rebuilt, rebuildChunks } = seed();
    const embedder = countingEmbedder();
    let calls = 0;
    const s1 = await runLibraryIndex(db, { rebuildChunks, embedder, shouldStop: () => calls++ > 1 });
    expect(s1.stopped).toBe(true);
    expect(rebuilt).toEqual([a.id]);
    const afterFirst = embedder.texts;
    expect(afterFirst).toBe(1);

    const s2 = await runLibraryIndex(db, { rebuildChunks, embedder });
    expect(s2.stopped).toBe(false);
    expect(rebuilt).toEqual([a.id, expect.any(Number)]);
    expect(embedder.texts - afterFirst).toBe(2);   // only b and c's chunks
    expect(planLibraryIndex(db, { embeddingModel: 'm' }).done).toBe(true);
  });

  it('stops embedding after the server fails once, but finishes chunking', async () => {
    const { db, rebuilt, rebuildChunks } = seed();
    const s = await runLibraryIndex(db, { rebuildChunks, embedder: countingEmbedder(true) });
    expect(s.embed_error).toMatch(/could not be reached/);
    expect(s.failures.filter(f => f.stage === 'embed')).toHaveLength(1);
    expect(rebuilt).toHaveLength(2);
    expect(s).toMatchObject({ chunked: 1, rechunked: 1, embedded_chunks: 0 });
  });

  it('runs each source inside the supplied lock', async () => {
    const { db, rebuildChunks } = seed();
    const locked: number[] = [];
    await runLibraryIndex(db, {
      rebuildChunks, embedder: null,
      withSourceLock: async (id, fn) => { locked.push(id); return fn(); },
    });
    expect(locked).toHaveLength(2);   // embeddings off: only the two sources needing chunks
  });
});
