// Whole-library passage index (RAG): chunk every source that has no chunks,
// re-chunk sources whose chunks predate the current chunker/layout, and (when
// embeddings are on) embed every chunk.
//
// Resumable without any job table: chunking commits per source, embedding
// commits per 64-chunk batch, and vectors are reused by (model, text hash). A
// stopped or crashed run is resumed by simply planning and running again.
//
// Never touches candidates, concepts, notes, history or user data — only
// rag_chunks (+ FTS via triggers) and chunk vectors. Never runs on its own: the
// app starts it only on an explicit user action.

import type { DatabaseSync } from '../core/infra/sqlite';
import type { Embedder } from '../core/embeddings';
import { CHUNKER_VERSION, LAYOUT_VERSION } from '../core/version';
import { indexSourceChunkEmbeddings } from './repos/rag_chunks';

export type ChunkAction = 'chunk' | 'rechunk' | null;

export interface LibraryIndexItem {
  source_id: number;
  title: string;
  page_count: number | null;
  chunks: number;
  action: ChunkAction;        // 'chunk' = none yet, 'rechunk' = older chunker/layout
  embedded: number;           // chunks with a vector for the model (0 when embeddings off)
  embed_missing: number;      // chunks still needing a vector (0 when embeddings off)
}

export interface LibraryIndexPlan {
  items: LibraryIndexItem[];  // in run order
  sources: number;
  unindexed: number;
  stale: number;
  chunks: number;
  embedded: number;
  embed_missing: number;
  embedding_model: string | null;
  done: boolean;              // nothing left to do
}

export interface PlanOptions {
  embeddingModel: string | null;                  // null = embeddings off
  versions?: { chunker: string; layout: string };
  // Per-source expected layout stamp (PDF parser choice); defaults to versions.layout.
  expectLayout?: (source: { source_id: number; file_path: string }) => string;
}

const ACTION_RANK: Record<string, number> = { chunk: 0, rechunk: 1, none: 2 };

// Pure read of the current state. Order: unindexed, then stale, then
// embed-only; smaller sources first within a group so coverage climbs fast.
export function planLibraryIndex(db: DatabaseSync, opts: PlanOptions): LibraryIndexPlan {
  const v = opts.versions ?? { chunker: CHUNKER_VERSION, layout: LAYOUT_VERSION };
  const model = opts.embeddingModel;
  const rows = db.prepare(
    `SELECT s.id AS id, COALESCE(s.title, s.filename) AS title, s.page_count AS page_count, s.file_path AS file_path,
            COUNT(c.id) AS chunks,
            SUM(CASE WHEN c.id IS NOT NULL AND c.chunker_version <> ? THEN 1 ELSE 0 END) AS stale_chunker,
            MIN(c.layout_version) AS layout_min, MAX(c.layout_version) AS layout_max,
            SUM(CASE WHEN c.id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM embeddings e WHERE e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?)
                THEN 1 ELSE 0 END) AS embedded
       FROM sources s LEFT JOIN rag_chunks c ON c.source_id = s.id
      GROUP BY s.id`,
  ).all(v.chunker, model ?? '') as Array<{
    id: number; title: string; page_count: number | null; file_path: string; chunks: number;
    stale_chunker: number; layout_min: string | null; layout_max: string | null; embedded: number;
  }>;

  const items: LibraryIndexItem[] = rows.map(r => {
    const chunks = Number(r.chunks);
    const layout = opts.expectLayout ? opts.expectLayout({ source_id: Number(r.id), file_path: r.file_path }) : v.layout;
    const stale = Number(r.stale_chunker) > 0 || r.layout_min !== layout || r.layout_max !== layout;
    const action: ChunkAction = chunks === 0 ? 'chunk' : stale ? 'rechunk' : null;
    const embedded = model ? Number(r.embedded) : 0;
    return {
      source_id: Number(r.id), title: r.title ?? '', page_count: r.page_count == null ? null : Number(r.page_count),
      chunks, action, embedded,
      // A (re)chunk invalidates the count; the runner re-plans after chunking.
      embed_missing: model ? (action ? Math.max(chunks - embedded, 1) : chunks - embedded) : 0,
    };
  });
  items.sort((a, b) =>
    ACTION_RANK[a.action ?? 'none'] - ACTION_RANK[b.action ?? 'none']
    || (a.page_count ?? Number.MAX_SAFE_INTEGER) - (b.page_count ?? Number.MAX_SAFE_INTEGER)
    || a.source_id - b.source_id);

  const sum = (f: (i: LibraryIndexItem) => number) => items.reduce((n, i) => n + f(i), 0);
  const plan: LibraryIndexPlan = {
    items,
    sources: items.length,
    unindexed: items.filter(i => i.action === 'chunk').length,
    stale: items.filter(i => i.action === 'rechunk').length,
    chunks: sum(i => i.chunks),
    embedded: sum(i => i.embedded),
    embed_missing: sum(i => (i.action ? 0 : i.embed_missing)),
    embedding_model: model,
    done: false,
  };
  plan.done = plan.unindexed === 0 && plan.stale === 0 && plan.embed_missing === 0;
  return plan;
}

export interface LibraryIndexProgress {
  phase: 'chunk' | 'embed';
  sourceId: number;
  title: string;
  sourceIndex: number;   // 1-based position in the run
  sourceCount: number;
  done: number;          // within this source (embed: chunks; chunk: 0 → 1)
  total: number;
}

export interface LibraryIndexFailure {
  source_id: number;
  title: string;
  stage: 'chunk' | 'embed';
  error: string;
}

export interface LibraryIndexSummary {
  stopped: boolean;
  sources_processed: number;
  chunked: number;            // sources chunked for the first time
  rechunked: number;          // stale sources re-chunked
  embedded_chunks: number;
  failures: LibraryIndexFailure[];
  // Set when the embedding server failed; vector work stopped for the rest of
  // the run (it would fail the same way) while chunking continued.
  embed_error: string | null;
}

export interface LibraryIndexDeps {
  // Re-segment the source file and reconcile its chunks. Throws on failure.
  rebuildChunks: (sourceId: number) => Promise<void>;
  embedder: Embedder | null;
  // Serialize with other per-source RAG work (Ask's lazy embedding, Index).
  withSourceLock?: <T>(sourceId: number, fn: () => Promise<T>) => Promise<T>;
  onProgress?: (p: LibraryIndexProgress) => void;
  shouldStop?: () => boolean;
  versions?: { chunker: string; layout: string };
  expectLayout?: PlanOptions['expectLayout'];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runLibraryIndex(db: DatabaseSync, deps: LibraryIndexDeps): Promise<LibraryIndexSummary> {
  const plan = planLibraryIndex(db, { embeddingModel: deps.embedder?.model ?? null, versions: deps.versions, expectLayout: deps.expectLayout });
  const work = plan.items.filter(i => i.action || i.embed_missing > 0);
  const summary: LibraryIndexSummary = {
    stopped: false, sources_processed: 0, chunked: 0, rechunked: 0, embedded_chunks: 0, failures: [], embed_error: null,
  };
  const lock = deps.withSourceLock ?? (<T>(_id: number, fn: () => Promise<T>) => fn());

  for (let i = 0; i < work.length; i++) {
    if (deps.shouldStop?.()) { summary.stopped = true; break; }
    const item = work[i];
    const base = { sourceId: item.source_id, title: item.title, sourceIndex: i + 1, sourceCount: work.length };
    await lock(item.source_id, async () => {
      if (item.action) {
        deps.onProgress?.({ ...base, phase: 'chunk', done: 0, total: 1 });
        try {
          await deps.rebuildChunks(item.source_id);
          if (item.action === 'chunk') summary.chunked++; else summary.rechunked++;
        } catch (e) {
          summary.failures.push({ source_id: item.source_id, title: item.title, stage: 'chunk', error: msg(e) });
          return;   // nothing reliable to embed for this source
        }
        deps.onProgress?.({ ...base, phase: 'chunk', done: 1, total: 1 });
      }
      if (!deps.embedder || summary.embed_error) return;
      try {
        const r = await indexSourceChunkEmbeddings(
          db, deps.embedder, item.source_id,
          (done, total) => deps.onProgress?.({ ...base, phase: 'embed', done, total }),
          deps.shouldStop,
        );
        summary.embedded_chunks += r.embedded;
        if (r.stopped) summary.stopped = true;
      } catch (e) {
        summary.embed_error = msg(e);
        summary.failures.push({ source_id: item.source_id, title: item.title, stage: 'embed', error: msg(e) });
      }
    });
    summary.sources_processed++;
    if (summary.stopped) break;
  }
  return summary;
}
