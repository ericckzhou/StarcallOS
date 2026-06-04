import { describe, it, expect } from 'vitest';
import { chunkBatches } from './batch';

describe('chunkBatches', () => {
  it('splits into fixed-size batches', () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2, 10)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('caps at maxBatches, dropping the overflow (left for a later pass)', () => {
    // 17 items / size 5 = 4 full + 1 partial, but capped to 3 batches (15 items).
    const items = Array.from({ length: 17 }, (_, i) => i);
    const batches = chunkBatches(items, 5, 3);
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toHaveLength(15);
    expect(batches.flat()).toEqual(items.slice(0, 15));
  });

  it('returns a single batch when everything fits', () => {
    expect(chunkBatches([1, 2, 3], 75, 12)).toEqual([[1, 2, 3]]);
  });

  it('returns nothing for empty input or non-positive bounds', () => {
    expect(chunkBatches([], 5, 5)).toEqual([]);
    expect(chunkBatches([1, 2], 0, 5)).toEqual([]);
    expect(chunkBatches([1, 2], 5, 0)).toEqual([]);
  });
});
