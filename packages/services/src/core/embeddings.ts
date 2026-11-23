// Embedding client + vector math. Pure Node (fetch), no native modules: vectors
// come from any OpenAI-compatible POST {baseUrl}/embeddings endpoint (Ollama
// `nomic-embed-text`, LM Studio, llama.cpp server). Opt-in; every consumer
// must degrade to its non-embedding behavior when this is unavailable.

import { createHash } from 'node:crypto';
import { normalizeLocalBaseUrl, DEFAULT_LOCAL_BASE_URL } from './llm';

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const EMBED_BATCH = 32;
const EMBED_TIMEOUT_MS = 30_000;
// Embedding models have short context windows; long quotes are truncated.
const EMBED_MAX_CHARS = 2_000;

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function createOpenAICompatEmbedder(baseUrlRaw: string | undefined, model: string = DEFAULT_EMBEDDING_MODEL): Embedder {
  const baseUrl = normalizeLocalBaseUrl(baseUrlRaw) ?? DEFAULT_LOCAL_BASE_URL;
  return {
    model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH).map(t => t.slice(0, EMBED_MAX_CHARS));
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, input: batch }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
          });
        } catch {
          throw new Error(`Embedding server at ${baseUrl} could not be reached.`);
        }
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(`Embedding server HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const body = await res.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
        const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== batch.length) {
          throw new Error(`Embedding server returned ${rows.length} vectors for ${batch.length} inputs.`);
        }
        for (const r of rows) {
          if (!Array.isArray(r.embedding) || r.embedding.length === 0) throw new Error('Embedding server returned an empty vector.');
          out.push(normalize(Float32Array.from(r.embedding)));
        }
      }
      return out;
    },
  };
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Cosine similarity. Inputs stored by this module are already unit-length, so
// this is a dot product; it still normalizes defensively for foreign vectors.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function encodeVec(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function decodeVec(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob); // detach from SQLite's buffer & align
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}
