import { describe, expect, it } from 'vitest';
import { normalize, type Embedder } from '../core/embeddings';
import { createCachingEmbedder, findCandidateNearDuplicates } from './candidate_duplicates';

// Vectors keyed by the first word, so "gradient …" texts collide on purpose.
function fake(): Embedder & { calls: number } {
  const e = {
    model: 'fake',
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map(t => {
        const w = t.toLowerCase();
        return normalize(Float32Array.from([w.includes('gradient') ? 1 : 0, w.includes('osmosis') ? 1 : 0, 0.05]));
      });
    },
  };
  return e;
}

describe('findCandidateNearDuplicates', () => {
  it('pairs similar candidates symmetrically and skips identical normalized terms', async () => {
    const r = await findCandidateNearDuplicates(fake(), [
      { id: 1, term: 'gradient descent', normalized: 'gradient descent' },
      { id: 2, term: 'gradient update rule', normalized: 'gradient update rule' },
      { id: 3, term: 'Gradient Descent', normalized: 'gradient descent' },
      { id: 4, term: 'osmosis', normalized: 'osmosis' },
    ]);
    expect(r[2]?.id === 1 || r[2]?.id === 3).toBe(true);
    expect(r[1]).toMatchObject({ id: 2, term: 'gradient update rule' });
    expect(r[1].similarity).toBeGreaterThan(0.93);
    expect(r[4]).toBeUndefined();
  });

  it('returns nothing for fewer than two candidates', async () => {
    expect(await findCandidateNearDuplicates(fake(), [{ id: 1, term: 'x', normalized: 'x' }])).toEqual({});
  });
});

describe('createCachingEmbedder', () => {
  it('embeds each distinct text once', async () => {
    const inner = fake();
    const cached = createCachingEmbedder(inner);
    await cached.embed(['gradient a', 'osmosis b', 'gradient a']);
    const again = await cached.embed(['osmosis b', 'gradient a']);
    expect(inner.calls).toBe(1);
    expect(again).toHaveLength(2);
  });

  it('evicts oldest entries past the bound', async () => {
    const inner = fake();
    const cached = createCachingEmbedder(inner, 2);
    await cached.embed(['a', 'b', 'c']);
    await cached.embed(['a']);
    expect(inner.calls).toBe(2);
  });
});
