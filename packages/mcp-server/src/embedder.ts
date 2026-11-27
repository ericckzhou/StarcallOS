// Query embedder for vector search, restricted to loopback. The services
// embedder already refuses redirects; this wrapper re-checks the host on every
// call (so a `localhost` that starts resolving elsewhere is caught) and caps
// the wait so a slow server degrades to keyword search instead of stalling.

import { assertLoopbackUrl, chunkEmbeddingModels, createOpenAICompatEmbedder, type Embedder, type LookupAll } from '@starcall/services';
import type { DatabaseSync } from 'node:sqlite';

export const QUERY_EMBED_TIMEOUT_MS = 8_000;

export interface EmbedderSetup {
  embedder: Embedder | null;
  // Why vector search is off, when it is.
  note: string | null;
}

export async function createLoopbackEmbedder(
  db: DatabaseSync,
  opts: { enabled: boolean; url: string; model: string | null; lookupAll?: LookupAll; timeoutMs?: number },
): Promise<EmbedderSetup> {
  if (!opts.enabled) return { embedder: null, note: 'Embeddings disabled (--no-embeddings).' };
  // Throws for a non-loopback URL: an explicit misconfiguration should stop
  // the server, not silently send text elsewhere.
  await assertLoopbackUrl(opts.url, opts.lookupAll);
  const model = opts.model ?? chunkEmbeddingModels(db)[0]?.model ?? null;
  if (!model) return { embedder: null, note: 'No passage embeddings in the library yet; keyword search only.' };
  const inner = createOpenAICompatEmbedder(opts.url, model);
  const timeoutMs = opts.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS;
  return {
    note: null,
    embedder: {
      model,
      baseUrl: inner.baseUrl,
      async embed(texts: string[]) {
        await assertLoopbackUrl(opts.url, opts.lookupAll);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Embedding server did not answer within ${timeoutMs} ms.`)), timeoutMs);
        });
        try {
          return await Promise.race([inner.embed(texts), timeout]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  };
}
