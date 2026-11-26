// Meaning search inside one source (the source preview's "≈" find mode).
//
// Hybrid retrieval over the source's passage index, collapsed to one hit per
// page (best passage first). It never embeds passages itself: that stays with
// Ask / the passage index. When vectors are missing or the embedding server is
// down it degrades to keyword matches and says why in `note`.

import type { DatabaseSync } from 'node:sqlite';
import type { Embedder } from '../core/embeddings';
import { chunkIndexStats } from './repos/rag_chunks';
import { retrieveChunks, type RetrievalMode } from './retrieval';

export interface SourceSearchHit {
  page: number;
  page_end: number;
  heading: string | null;
  snippet: string;
}

export interface SourceSearchResult {
  mode_used: RetrievalMode;
  note: string | null;
  hits: SourceSearchHit[];
}

const SNIPPET_CHARS = 180;
const POOL = 24;        // passages retrieved before collapsing to pages
const MAX_PAGES = 12;

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS).trimEnd()}…` : flat;
}

export async function searchSourcePassages(
  db: DatabaseSync,
  sourceId: number,
  query: string,
  embedder: Embedder | null,
): Promise<SourceSearchResult> {
  const stats = chunkIndexStats(db, embedder?.model, sourceId);
  if (stats.chunks === 0) {
    return { mode_used: 'keyword', note: 'This source has no passage index yet. Index it from the Ask tab to search by meaning.', hits: [] };
  }

  let note: string | null = null;
  let mode: RetrievalMode = 'hybrid';
  if (!embedder) {
    mode = 'keyword';
    note = 'Embeddings are off (Settings → Embeddings), so these are keyword matches.';
  } else if (stats.embedded === 0) {
    mode = 'keyword';
    note = 'Passages are not embedded yet, so these are keyword matches. Ask about this source or run the passage index to search by meaning.';
  } else if (stats.embedded < stats.chunks) {
    note = `Only ${stats.embedded} of ${stats.chunks} passages are embedded; the rest match by keyword only.`;
  }

  const r = await retrieveChunks(db, { query, mode, k: POOL, sourceIds: [sourceId], embedder });
  if (mode === 'hybrid' && r.mode_used === 'keyword') {
    note = `Embedding server unavailable${r.vector_error ? ` (${r.vector_error})` : ''}, so these are keyword matches.`;
  }

  const seen = new Set<number>();
  const hits: SourceSearchHit[] = [];
  for (const h of r.hits) {
    if (seen.has(h.page_start)) continue;
    seen.add(h.page_start);
    hits.push({ page: h.page_start, page_end: h.page_end, heading: h.heading, snippet: snippetOf(h.text) });
    if (hits.length >= MAX_PAGES) break;
  }
  return { mode_used: r.mode_used, note, hits };
}
