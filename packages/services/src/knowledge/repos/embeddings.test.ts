import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../core/infra/db';
import { cosine, decodeVec, encodeVec, normalize, type Embedder } from '../../core/embeddings';
import { createSource } from './sources';
import { buildGroundingContext, createConcept, deleteConcept } from './concepts';
import { clearDerivedDataForSource } from '../cleanup';
import { embeddingStats, indexSourceEmbeddings, relatedConcepts, retrieveSourceExcerpts } from './embeddings';

// Deterministic fake: bag-of-keywords vectors so similarity is predictable.
const VOCAB = ['hash', 'ring', 'node', 'water', 'membrane', 'solute', 'cell', 'key', 'price', 'cost'];
function fakeEmbedder(model = 'fake'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(t => normalize(Float32Array.from(VOCAB.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.01]))));
    },
  };
}

function seed() {
  const db = openDb(':memory:');
  const s1 = createSource(db, { filename: 'ddia.pdf', file_path: 'ddia.pdf', title: 'DDIA' });
  const s2 = createSource(db, { filename: 'bio.pdf', file_path: 'bio.pdf', title: 'Bio' });
  const mk = (source_id: number, name: string, def: string, quotes: string[]) => {
    const c = createConcept(db, {
      source_id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), importance: 'core',
      definition_text: def, why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
      section_path: [], exam_value: 0.5, misconception_risk: 0.5, centrality_score: 0.5,
    });
    db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?')
      .run(JSON.stringify(quotes.map((quote, i) => ({ kind: 'definition', quote, page: i + 1 }))), c.id);
    return c;
  };
  const hashing = mk(s1.id, 'Consistent hashing', 'keys and nodes on a hash ring', ['Each node owns the arc of the hash ring before it, so a key maps to the next node.']);
  const rebalance = mk(s1.id, 'Rebalancing', 'moving partitions between nodes', ['When a node joins the ring only keys on its arc move; the hash of every other key is unchanged.']);
  const osmosis = mk(s2.id, 'Osmosis', 'water crosses a membrane toward higher solute', ['Water moves across the membrane toward the side with more solute, so the cell swells.']);
  return { db, s1, s2, hashing, rebalance, osmosis };
}

describe('vector helpers', () => {
  it('round-trips Float32 blobs and computes cosine', () => {
    const v = normalize(Float32Array.from([3, 4]));
    expect(Array.from(decodeVec(encodeVec(v)))).toEqual(Array.from(v));
    expect(cosine(v, v)).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });
});

describe('embedding index', () => {
  it('indexes incrementally and prunes on change/delete', async () => {
    const { db, s1, rebalance } = seed();
    const emb = fakeEmbedder();
    const first = await indexSourceEmbeddings(db, emb, s1.id);
    expect(first).toEqual({ embedded: 4, pruned: 0, total: 4 }); // 2 concepts + 2 spans

    const again = await indexSourceEmbeddings(db, emb, s1.id);
    expect(again.embedded).toBe(0);
    expect(emb.calls).toHaveLength(1);

    db.prepare('UPDATE concepts SET definition_text = ? WHERE id = ?').run('changed definition about the ring', rebalance.id);
    expect(await indexSourceEmbeddings(db, emb, s1.id)).toMatchObject({ embedded: 1, pruned: 1 });

    deleteConcept(db, rebalance.id);
    expect(await indexSourceEmbeddings(db, emb, s1.id)).toMatchObject({ embedded: 0, pruned: 2 });
  });

  it('replaces rows from a different model', async () => {
    const { db, s1 } = seed();
    await indexSourceEmbeddings(db, fakeEmbedder('a'), s1.id);
    const r = await indexSourceEmbeddings(db, fakeEmbedder('b'), s1.id);
    expect(r).toMatchObject({ embedded: 4, pruned: 4 });
    expect(embeddingStats(db, 'a').concepts).toBe(0);
  });

  it('retrieves similar quotes from other concepts in the same source only', async () => {
    const { db, s1, s2, hashing } = seed();
    const emb = fakeEmbedder();
    await indexSourceEmbeddings(db, emb, s1.id);
    await indexSourceEmbeddings(db, emb, s2.id);
    const hits = await retrieveSourceExcerpts(db, emb, s1.id, 'a new node joins the hash ring and keys move', hashing.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('When a node joins');
    expect(hits.every(h => h.conceptId !== hashing.id)).toBe(true);
  });

  it('suggests related concepts across sources from stored vectors without network', async () => {
    const { db, s1, s2, hashing, rebalance, osmosis } = seed();
    const emb = fakeEmbedder();
    await indexSourceEmbeddings(db, emb, s1.id);
    await indexSourceEmbeddings(db, emb, s2.id);
    const callsBefore = emb.calls.length;
    const rel = relatedConcepts(db, 'fake', hashing.id, 5, 0.3);
    expect(emb.calls.length).toBe(callsBefore);
    expect(rel.map(r => r.id)).toContain(rebalance.id);
    expect(rel.map(r => r.id)).not.toContain(osmosis.id);
    expect(rel.find(r => r.id === rebalance.id)?.source_title).toBe('DDIA');
    expect(relatedConcepts(db, 'other-model', hashing.id)).toEqual([]);
  });

  it('is wiped with derived data on re-extract', async () => {
    const { db, s1 } = seed();
    await indexSourceEmbeddings(db, fakeEmbedder(), s1.id);
    clearDerivedDataForSource(db, s1.id);
    expect(embeddingStats(db, 'fake').concepts).toBe(0);
  });
});

describe('buildGroundingContext extra excerpts', () => {
  it('appends retrieved excerpts only when the concept has its own material', () => {
    const { db, hashing } = seed();
    const ctx = buildGroundingContext(db, hashing.id, ['When a node joins the ring only keys on its arc move.']);
    expect(ctx.hasContext).toBe(true);
    expect(ctx.context).toContain('Related source excerpt');

    db.prepare("UPDATE concepts SET definition_text = '', evidence_json = '[]' WHERE id = ?").run(hashing.id);
    const sparse = buildGroundingContext(db, hashing.id, ['x'.repeat(500)]);
    expect(sparse).toEqual({ context: '', hasContext: false });
  });

  it('does not duplicate an excerpt already in the concept evidence', () => {
    const { db, hashing } = seed();
    const own = 'Each node owns the arc of the hash ring before it, so a key maps to the next node.';
    expect(buildGroundingContext(db, hashing.id, [own]).context).not.toContain('Related source excerpt');
  });
});

vi.setConfig({ testTimeout: 10_000 });
