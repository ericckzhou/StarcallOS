// Split a list into fixed-size batches, capped at maxBatches. Used by the
// full-coverage LLM topic filter to turn the deduped candidate list into a
// bounded sequence of paced calls — the cap is the hard ceiling that stops a
// huge source from firing dozens of requests into a rate limit. Pure and
// synchronous so the batching/cap math is unit-testable without the LLM.
export function chunkBatches<T>(items: T[], size: number, maxBatches: number): T[][] {
  if (size <= 0 || maxBatches <= 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length && out.length < maxBatches; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
