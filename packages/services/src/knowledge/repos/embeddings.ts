// Embedding index over promoted concepts and their evidence quotes
// (migration 0033). Derived + incremental: indexing a source embeds only text
// whose hash/model is not already stored, and prunes rows whose text changed or
// whose concept is gone. Search is brute-force cosine in TS — a library holds
// thousands of vectors at most, which is microseconds of work.

import type { DatabaseSync } from '../../core/infra/sqlite';
import { cosine, decodeVec, encodeVec, textHash, type Embedder } from '../../core/embeddings';
import { listConceptSourceEvidence, listConceptsBySource } from './concepts';

type OwnerKind = 'concept' | 'span';

interface Wanted { kind: OwnerKind; ownerId: number; text: string; hash: string }

export interface IndexResult { embedded: number; pruned: number; total: number }

function conceptText(name: string, definition: string): string {
  const d = definition.trim();
  return d ? `${name}: ${d}` : name;
}

// Minimum quote length worth embedding (shorter quotes are mostly labels).
const MIN_SPAN_CHARS = 40;

function wantedForSource(db: DatabaseSync, sourceId: number): Wanted[] {
  const out: Wanted[] = [];
  for (const c of listConceptsBySource(db, sourceId)) {
    const ct = conceptText(c.name, c.definition_text ?? '');
    out.push({ kind: 'concept', ownerId: c.id, text: ct, hash: textHash(ct) });
    const seen = new Set<string>();
    for (const e of listConceptSourceEvidence(db, c.id)?.evidence ?? []) {
      const q = e.quote?.trim();
      if (!q || q.length < MIN_SPAN_CHARS) continue;
      const h = textHash(q);
      if (seen.has(h)) continue;
      seen.add(h);
      out.push({ kind: 'span', ownerId: c.id, text: q, hash: h });
    }
  }
  return out;
}

export async function indexSourceEmbeddings(db: DatabaseSync, embedder: Embedder, sourceId: number): Promise<IndexResult> {
  const wanted = wantedForSource(db, sourceId);
  // Scoped to concept/span rows: chunk vectors (owner_kind 'chunk') share this
  // table but are owned by indexSourceChunkEmbeddings (repos/rag_chunks.ts).
  const existing = db.prepare(
    `SELECT id, owner_kind, owner_id, text_hash FROM embeddings
      WHERE source_id = ? AND model = ? AND owner_kind IN ('concept', 'span')`,
  ).all(sourceId, embedder.model) as Array<{ id: number; owner_kind: OwnerKind; owner_id: number; text_hash: string }>;

  const key = (k: string, o: number, h: string) => `${k}|${o}|${h}`;
  const have = new Map(existing.map(r => [key(r.owner_kind, Number(r.owner_id), r.text_hash), Number(r.id)]));
  const wantKeys = new Set(wanted.map(w => key(w.kind, w.ownerId, w.hash)));

  // Prune stale rows (text changed, concept deleted, or another model).
  const stale = existing.filter(r => !wantKeys.has(key(r.owner_kind, Number(r.owner_id), r.text_hash))).map(r => Number(r.id));
  const otherModel = db.prepare(
    `DELETE FROM embeddings WHERE source_id = ? AND model <> ? AND owner_kind IN ('concept', 'span')`,
  ).run(sourceId, embedder.model);
  const del = db.prepare(`DELETE FROM embeddings WHERE id = ?`);
  for (const id of stale) del.run(id);

  const missing = wanted.filter(w => !have.has(key(w.kind, w.ownerId, w.hash)));
  if (missing.length > 0) {
    const vecs = await embedder.embed(missing.map(m => m.text));
    const ins = db.prepare(
      `INSERT OR IGNORE INTO embeddings (source_id, owner_kind, owner_id, text, text_hash, model, dim, vec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      missing.forEach((m, i) => ins.run(sourceId, m.kind, m.ownerId, m.text, m.hash, embedder.model, vecs[i].length, encodeVec(vecs[i])));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { embedded: missing.length, pruned: stale.length + Number(otherModel.changes), total: wanted.length };
}

interface VecRow { owner_id: number; text: string; vec: Uint8Array; source_id: number }

// Evidence quotes from OTHER concepts in the same source that are most similar
// to `query` (typically the learner's answer). Used to widen grounding context
// beyond the graded concept's own spans.
export async function retrieveSourceExcerpts(
  db: DatabaseSync,
  embedder: Embedder,
  sourceId: number,
  query: string,
  excludeConceptId: number,
  k = 3,
  minSimilarity = 0.55,
): Promise<Array<{ conceptId: number; text: string; similarity: number }>> {
  const rows = db.prepare(
    `SELECT e.owner_id, e.text, e.vec, e.source_id FROM embeddings e
       JOIN concepts c ON c.id = e.owner_id
      WHERE e.source_id = ? AND e.owner_kind = 'span' AND e.model = ? AND e.owner_id <> ?`,
  ).all(sourceId, embedder.model, excludeConceptId) as unknown as VecRow[];
  if (rows.length === 0 || !query.trim()) return [];
  const [q] = await embedder.embed([query]);
  return rows
    .map(r => ({ conceptId: Number(r.owner_id), text: r.text, similarity: cosine(q, decodeVec(r.vec)) }))
    .filter(r => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

export interface RelatedConcept {
  id: number;
  name: string;
  source_id: number;
  source_title: string;
  similarity: number;
}

// Concepts across ALL sources most similar to `conceptId`, from stored vectors
// only (no network). Returns [] when the concept has no vector yet. Excludes
// the concept itself and same-name duplicates. Suggestions only — callers must
// never write constellations/edges from this without a user action.
export function relatedConcepts(db: DatabaseSync, model: string, conceptId: number, k = 8, minSimilarity = 0.6): RelatedConcept[] {
  const self = db.prepare(
    `SELECT vec FROM embeddings WHERE owner_kind = 'concept' AND owner_id = ? AND model = ? ORDER BY id DESC LIMIT 1`,
  ).get(conceptId, model) as { vec: Uint8Array } | undefined;
  if (!self) return [];
  const q = decodeVec(self.vec);
  const selfName = (db.prepare('SELECT name FROM concepts WHERE id = ?').get(conceptId) as { name?: string } | undefined)?.name?.toLowerCase();
  const rows = db.prepare(
    `SELECT e.owner_id, e.vec, c.name, c.source_id, COALESCE(s.title, s.filename) AS source_title
       FROM embeddings e
       JOIN concepts c ON c.id = e.owner_id
       JOIN sources s ON s.id = c.source_id
      WHERE e.owner_kind = 'concept' AND e.model = ? AND e.owner_id <> ?`,
  ).all(model, conceptId) as unknown as Array<{ owner_id: number; vec: Uint8Array; name: string; source_id: number; source_title: string }>;
  const best = new Map<number, RelatedConcept>();
  for (const r of rows) {
    if (selfName && r.name.toLowerCase() === selfName) continue;
    const sim = cosine(q, decodeVec(r.vec));
    if (sim < minSimilarity) continue;
    const id = Number(r.owner_id);
    const prev = best.get(id);
    if (!prev || sim > prev.similarity) {
      best.set(id, { id, name: r.name, source_id: Number(r.source_id), source_title: r.source_title, similarity: sim });
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

export function embeddingStats(db: DatabaseSync, model: string): { concepts: number; spans: number; sources: number } {
  const r = db.prepare(
    `SELECT SUM(owner_kind = 'concept') AS concepts, SUM(owner_kind = 'span') AS spans, COUNT(DISTINCT source_id) AS sources
       FROM embeddings WHERE model = ?`,
  ).get(model) as { concepts: number | null; spans: number | null; sources: number | null };
  return { concepts: Number(r.concepts ?? 0), spans: Number(r.spans ?? 0), sources: Number(r.sources ?? 0) };
}
