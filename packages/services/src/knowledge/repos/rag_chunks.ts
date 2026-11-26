// Persistence for the retrieval chunk index (migration 0036). rag_chunks is a
// derived index of the layout blocks; it is RECONCILED by chunk_key rather
// than wiped, so re-processing an unchanged document writes nothing and keeps
// every chunk id (and therefore every chunk vector) intact.
//
// Chunk vectors live in the shared `embeddings` table as owner_kind 'chunk',
// owner_id = rag_chunks.id, using the same text-hash/model caching as the
// concept/span index. They are only computed on demand
// (indexSourceChunkEmbeddings) — processing a source never calls a model.

import type { DatabaseSync } from '../../core/infra/sqlite';
import { decodeVec, encodeVec, textHash, type Embedder } from '../../core/embeddings';
import { CHUNKER_VERSION, LAYOUT_VERSION } from '../../core/version';
import type { ChunkDraft } from '../../ingestion/chunker';

export interface RagChunk {
  id: number;
  source_id: number;
  chunk_key: string;
  ordinal: number;
  text: string;
  heading: string | null;
  section_path: string[];
  section_text: string;
  page_start: number;
  page_end: number;
  block_start: number;
  block_end: number;
  block_count: number;
  has_formula: boolean;
  char_count: number;
  text_hash: string;
  chunker_version: string;
  layout_version: string;
}

interface RagChunkRow extends Omit<RagChunk, 'section_path' | 'has_formula'> {
  section_path_json: string;
  has_formula: number;
}

function fromRow(r: RagChunkRow): RagChunk {
  let path: string[] = [];
  try { path = JSON.parse(r.section_path_json) as string[]; } catch { path = []; }
  return {
    id: Number(r.id), source_id: Number(r.source_id), chunk_key: r.chunk_key, ordinal: Number(r.ordinal),
    text: r.text, heading: r.heading, section_path: path, section_text: r.section_text,
    page_start: Number(r.page_start), page_end: Number(r.page_end),
    block_start: Number(r.block_start), block_end: Number(r.block_end), block_count: Number(r.block_count),
    has_formula: Number(r.has_formula) === 1, char_count: Number(r.char_count), text_hash: r.text_hash,
    chunker_version: r.chunker_version, layout_version: r.layout_version,
  };
}

const COLS = `id, source_id, chunk_key, ordinal, text, heading, section_path_json, section_text,
  page_start, page_end, block_start, block_end, block_count, has_formula, char_count, text_hash,
  chunker_version, layout_version`;

export function listSourceChunks(db: DatabaseSync, sourceId: number): RagChunk[] {
  const rows = db.prepare(`SELECT ${COLS} FROM rag_chunks WHERE source_id = ? ORDER BY ordinal, id`)
    .all(sourceId) as unknown as RagChunkRow[];
  return rows.map(fromRow);
}

// The chunk that directly follows each given chunk in reading order, when it
// is in the same section (a passage that continues the same argument). Keyed
// by the anchor chunk id; anchors with no such follower are absent.
export function getNextChunksInSection(db: DatabaseSync, ids: number[]): Map<number, RagChunk> {
  if (ids.length === 0) return new Map();
  const cols = COLS.split(',').map(c => `n.${c.trim()}`).join(', ');
  const rows = db.prepare(
    `SELECT c.id AS anchor_id, ${cols} FROM rag_chunks c
       JOIN rag_chunks n ON n.source_id = c.source_id AND n.ordinal = c.ordinal + 1 AND n.section_text = c.section_text
      WHERE c.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as unknown as Array<RagChunkRow & { anchor_id: number }>;
  return new Map(rows.map(r => [Number(r.anchor_id), fromRow(r)]));
}

export function getChunksByIds(db: DatabaseSync, ids: number[]): RagChunk[] {
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT ${COLS} FROM rag_chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as RagChunkRow[];
  const byId = new Map(rows.map(r => [Number(r.id), fromRow(r)]));
  return ids.map(id => byId.get(id)).filter((c): c is RagChunk => c != null);
}

export interface ChunkSyncResult {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

function deleteChunkVectors(db: DatabaseSync, chunkIds: number[]): void {
  const del = db.prepare(`DELETE FROM embeddings WHERE owner_kind = 'chunk' AND owner_id = ?`);
  for (const id of chunkIds) del.run(id);
}

// Reconcile a source's chunk rows with a fresh chunker result. Keyed by
// chunk_key (content-addressed), so unchanged chunks keep their row id; only
// positional/metadata drift is updated. Atomic.
export function syncSourceChunks(
  db: DatabaseSync,
  sourceId: number,
  drafts: ChunkDraft[],
  versions: { chunker: string; layout: string } = { chunker: CHUNKER_VERSION, layout: LAYOUT_VERSION },
): ChunkSyncResult {
  const existing = new Map(
    (db.prepare(`SELECT ${COLS} FROM rag_chunks WHERE source_id = ?`).all(sourceId) as unknown as RagChunkRow[])
      .map(r => [r.chunk_key, r]),
  );
  const result: ChunkSyncResult = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  const ins = db.prepare(
    `INSERT INTO rag_chunks (source_id, chunk_key, ordinal, text, heading, section_path_json, section_text,
       page_start, page_end, block_start, block_end, block_count, has_formula, char_count, text_hash,
       chunker_version, layout_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare(
    `UPDATE rag_chunks SET ordinal = ?, heading = ?, section_path_json = ?, section_text = ?,
       page_start = ?, page_end = ?, block_start = ?, block_end = ?, block_count = ?, has_formula = ?,
       chunker_version = ?, layout_version = ?, updated_at = datetime('now')
     WHERE id = ?`,
  );
  const del = db.prepare(`DELETE FROM rag_chunks WHERE id = ?`);

  db.exec('BEGIN');
  try {
    const keep = new Set<string>();
    for (const d of drafts) {
      keep.add(d.chunk_key);
      const pathJson = JSON.stringify(d.section_path);
      const row = existing.get(d.chunk_key);
      if (!row) {
        ins.run(sourceId, d.chunk_key, d.ordinal, d.text, d.heading, pathJson, d.section_text,
          d.page_start, d.page_end, d.block_start, d.block_end, d.block_count, d.has_formula ? 1 : 0,
          d.char_count, d.text_hash, versions.chunker, versions.layout);
        result.inserted++;
        continue;
      }
      const same = Number(row.ordinal) === d.ordinal && row.heading === d.heading
        && row.section_path_json === pathJson && row.section_text === d.section_text
        && Number(row.page_start) === d.page_start && Number(row.page_end) === d.page_end
        && Number(row.block_start) === d.block_start && Number(row.block_end) === d.block_end
        && Number(row.block_count) === d.block_count && Number(row.has_formula) === (d.has_formula ? 1 : 0)
        && row.chunker_version === versions.chunker && row.layout_version === versions.layout;
      if (same) { result.unchanged++; continue; }
      upd.run(d.ordinal, d.heading, pathJson, d.section_text, d.page_start, d.page_end,
        d.block_start, d.block_end, d.block_count, d.has_formula ? 1 : 0, versions.chunker, versions.layout, Number(row.id));
      result.updated++;
    }
    const gone = [...existing.values()].filter(r => !keep.has(r.chunk_key)).map(r => Number(r.id));
    for (const id of gone) del.run(id);
    deleteChunkVectors(db, gone);
    result.deleted = gone.length;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

// Remove a source's whole chunk index (rows, FTS entries via trigger, vectors).
export function deleteSourceChunks(db: DatabaseSync, sourceId: number): number {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM embeddings WHERE source_id = ? AND owner_kind = 'chunk'`).run(sourceId);
    const r = db.prepare(`DELETE FROM rag_chunks WHERE source_id = ?`).run(sourceId);
    db.exec('COMMIT');
    return Number(r.changes);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface ChunkIndexStats {
  chunks: number;
  sources: number;
  embedded: number;  // chunks with a vector for `model` (0 when model omitted)
}

export function chunkIndexStats(db: DatabaseSync, model?: string, sourceId?: number): ChunkIndexStats {
  const where = sourceId != null ? 'WHERE c.source_id = ?' : '';
  const args = sourceId != null ? [sourceId] : [];
  const base = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT c.source_id) AS s FROM rag_chunks c ${where}`)
    .get(...args) as { n: number; s: number };
  let embedded = 0;
  if (model) {
    const r = db.prepare(
      `SELECT COUNT(DISTINCT c.id) AS n FROM rag_chunks c
         JOIN embeddings e ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
       ${where}`,
    ).get(model, ...args) as { n: number };
    embedded = Number(r.n);
  }
  return { chunks: Number(base.n), sources: Number(base.s), embedded };
}

// ─── Chunk vectors ───────────────────────────────────────────────────────────

// nomic-embed-text is trained with asymmetric task prefixes; retrieval quality
// drops noticeably without them. Other models get the raw text.
export function documentEmbeddingText(model: string, chunk: Pick<RagChunk, 'text' | 'section_text'>): string {
  const body = chunk.section_text ? `${chunk.section_text}\n${chunk.text}` : chunk.text;
  return /nomic/i.test(model) ? `search_document: ${body}` : body;
}

export function queryEmbeddingText(model: string, query: string): string {
  return /nomic/i.test(model) ? `search_query: ${query}` : query;
}

export interface ChunkEmbeddingResult { embedded: number; pruned: number; total: number; stopped?: boolean }

// Embed every chunk of a source that has no vector for (embedder.model, its
// current text). Incremental: re-running on an unchanged index embeds nothing.
// Vectors from another model are replaced, matching indexSourceEmbeddings.
export async function indexSourceChunkEmbeddings(
  db: DatabaseSync,
  embedder: Embedder,
  sourceId: number,
  onProgress?: (done: number, total: number) => void,
  // Checked before each batch; already-committed batches are kept, so a
  // stopped run resumes exactly where it left off.
  shouldStop?: () => boolean,
): Promise<ChunkEmbeddingResult> {
  const chunks = listSourceChunks(db, sourceId);
  const wanted = chunks.map(c => {
    const text = documentEmbeddingText(embedder.model, c);
    return { id: c.id, text, hash: textHash(text) };
  });
  const existing = db.prepare(
    `SELECT id, owner_id, text_hash FROM embeddings WHERE source_id = ? AND owner_kind = 'chunk' AND model = ?`,
  ).all(sourceId, embedder.model) as Array<{ id: number; owner_id: number; text_hash: string }>;
  const wantKeys = new Set(wanted.map(w => `${w.id}|${w.hash}`));
  const have = new Set(existing.map(r => `${Number(r.owner_id)}|${r.text_hash}`));

  const stale = existing.filter(r => !wantKeys.has(`${Number(r.owner_id)}|${r.text_hash}`)).map(r => Number(r.id));
  const otherModel = db.prepare(
    `DELETE FROM embeddings WHERE source_id = ? AND owner_kind = 'chunk' AND model <> ?`,
  ).run(sourceId, embedder.model);
  const delOne = db.prepare(`DELETE FROM embeddings WHERE id = ?`);
  for (const id of stale) delOne.run(id);

  const missing = wanted.filter(w => !have.has(`${w.id}|${w.hash}`));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO embeddings (source_id, owner_kind, owner_id, text, text_hash, model, dim, vec)
     VALUES (?, 'chunk', ?, ?, ?, ?, ?, ?)`,
  );
  // Commit in batches so a long first-time index survives an interruption.
  const BATCH = 64;
  let embedded = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    if (shouldStop?.()) {
      return { embedded, pruned: stale.length + Number(otherModel.changes), total: wanted.length, stopped: true };
    }
    const batch = missing.slice(i, i + BATCH);
    const vecs = await embedder.embed(batch.map(m => m.text));
    db.exec('BEGIN');
    try {
      batch.forEach((m, j) => ins.run(sourceId, m.id, m.text, m.hash, embedder.model, vecs[j].length, encodeVec(vecs[j])));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    embedded += batch.length;
    onProgress?.(Math.min(i + BATCH, missing.length), missing.length);
  }
  return { embedded, pruned: stale.length + Number(otherModel.changes), total: wanted.length };
}

// Chunk vectors for `model`, optionally limited to some sources. One vector per
// chunk (the newest row wins if a stale duplicate survived).
export function loadChunkVectors(
  db: DatabaseSync,
  model: string,
  sourceIds?: number[],
): Array<{ chunkId: number; vec: Float32Array }> {
  const filter = sourceIds && sourceIds.length ? `AND c.source_id IN (${sourceIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(
    `SELECT c.id AS chunk_id, e.vec AS vec FROM rag_chunks c
       JOIN embeddings e ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
      WHERE 1 = 1 ${filter}
      ORDER BY e.id`,
  ).all(model, ...(sourceIds ?? [])) as unknown as Array<{ chunk_id: number; vec: Uint8Array }>;
  const byChunk = new Map<number, Float32Array>();
  for (const r of rows) byChunk.set(Number(r.chunk_id), decodeVec(r.vec));
  return [...byChunk.entries()].map(([chunkId, vec]) => ({ chunkId, vec }));
}
