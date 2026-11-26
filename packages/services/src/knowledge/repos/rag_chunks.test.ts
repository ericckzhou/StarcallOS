import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from '../../core/infra/sqlite';
import { openDb } from '../../core/infra/db';
import { hasFts5 } from '../../core/infra/fts';
import { runMigrations } from '../../core/infra/migrate';
import { normalize, type Embedder } from '../../core/embeddings';
import type { BlockHint, SegmentedBlock } from '../../ingestion/layout';
import { chunkBlocks } from '../../ingestion/chunker';
import { createSource, deleteSource } from './sources';
import { createConcept } from './concepts';
import { clearDerivedDataForSource } from '../cleanup';
import { indexSourceEmbeddings } from './embeddings';
import {
  chunkIndexStats, deleteSourceChunks, documentEmbeddingText, indexSourceChunkEmbeddings,
  listSourceChunks, queryEmbeddingText, syncSourceChunks,
} from './rag_chunks';

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}

function book(extra = ''): SegmentedBlock[] {
  order = 0;
  return [
    blk('1 Induction', 1, 'heading'),
    blk('The principle of mathematical induction proves a predicate for every natural number using a basis and an induction step.', 1),
    blk('2 Binary search', 2, 'heading'),
    blk(`Binary search halves the interval on every iteration; its loop invariant keeps the target inside the bounds.${extra}`, 2),
    blk('3 Regular expressions', 3, 'heading'),
    blk('A regular expression denotes a language; Kleene star allows zero or more repetitions.', 3),
  ];
}

function fakeEmbedder(model = 'fake'): Embedder & { calls: string[][] } {
  const VOCAB = ['induction', 'binary', 'search', 'regular', 'expression', 'loop', 'kleene'];
  const calls: string[][] = [];
  return {
    model, calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(t => normalize(Float32Array.from([...VOCAB.map(w => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01])));
    },
  };
}

function seed() {
  const db = openDb(':memory:');
  const s = createSource(db, { filename: 'b36.pdf', file_path: 'b36.pdf', title: 'B36' });
  return { db, s };
}

describe('FTS5 capability', () => {
  it('is available in the bundled SQLite (migration 0036 depends on it)', () => {
    const db = new DatabaseSync(':memory:');
    expect(hasFts5(db)).toBe(true);
  });
});

describe('migration 0036', () => {
  it('rebuilds embeddings without losing rows and allows chunk vectors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-mig-'));
    const all = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    for (const f of all.filter(f => f < '0036')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, dir);
    db.prepare(`INSERT INTO sources (id, filename, file_path) VALUES (7, 'x.pdf', 'x.pdf')`).run();
    db.prepare(
      `INSERT INTO embeddings (id, source_id, owner_kind, owner_id, text, text_hash, model, dim, vec)
       VALUES (42, 7, 'span', 3, 'quote', 'h1', 'm', 2, x'0000803f00000000')`,
    ).run();
    expect(() => db.prepare(
      `INSERT INTO embeddings (source_id, owner_kind, owner_id, text, text_hash, model, dim, vec) VALUES (7, 'chunk', 1, 't', 'h', 'm', 1, x'00')`,
    ).run()).toThrow();

    fs.copyFileSync(path.join(MIGRATIONS, '0036_rag_chunks.sql'), path.join(dir, '0036_rag_chunks.sql'));
    expect(runMigrations(db, dir)).toEqual(['0036_rag_chunks.sql']);
    const kept = db.prepare(`SELECT id, owner_kind, text_hash FROM embeddings`).all();
    expect(kept).toEqual([{ id: 42, owner_kind: 'span', text_hash: 'h1' }]);
    db.prepare(
      `INSERT INTO embeddings (source_id, owner_kind, owner_id, text, text_hash, model, dim, vec) VALUES (7, 'chunk', 1, 't', 'h', 'm', 1, x'00')`,
    ).run();
    // Source delete still cascades after the rebuild.
    db.prepare(`DELETE FROM sources WHERE id = 7`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get()).toEqual({ n: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('syncSourceChunks', () => {
  it('persists chunks with metadata and indexes them in FTS', () => {
    const { db, s } = seed();
    const drafts = chunkBlocks(book()).chunks;
    expect(syncSourceChunks(db, s.id, drafts)).toEqual({ inserted: 3, updated: 0, deleted: 0, unchanged: 0 });
    const rows = listSourceChunks(db, s.id);
    expect(rows.map(r => r.section_path)).toEqual([['1 Induction'], ['2 Binary search'], ['3 Regular expressions']]);
    expect(rows[1]).toMatchObject({ page_start: 2, page_end: 2, ordinal: 1, has_formula: false, chunker_version: expect.any(String) });
    const fts = db.prepare(`SELECT rowid FROM rag_chunks_fts WHERE rag_chunks_fts MATCH '"invariant"'`).all() as Array<{ rowid: number }>;
    expect(fts.map(r => Number(r.rowid))).toEqual([rows[1].id]);
  });

  it('is a no-op for an unchanged document and keeps chunk ids', () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    const ids = listSourceChunks(db, s.id).map(c => c.id);
    expect(syncSourceChunks(db, s.id, chunkBlocks(book()).chunks)).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 3 });
    expect(listSourceChunks(db, s.id).map(c => c.id)).toEqual(ids);
  });

  it('replaces only changed chunks and drops their vectors and FTS rows', async () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    const emb = fakeEmbedder();
    await indexSourceChunkEmbeddings(db, emb, s.id);
    const before = listSourceChunks(db, s.id);

    const r = syncSourceChunks(db, s.id, chunkBlocks(book(' It runs in logarithmic time.')).chunks);
    expect(r).toEqual({ inserted: 1, updated: 0, deleted: 1, unchanged: 2 });
    const after = listSourceChunks(db, s.id);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE owner_kind = 'chunk' AND owner_id = ?`).get(before[1].id)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE rag_chunks_fts MATCH '"logarithmic"'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE rowid = ?`).get(before[1].id)).toEqual({ n: 0 });

    const again = await indexSourceChunkEmbeddings(db, emb, s.id);
    expect(again).toEqual({ embedded: 1, pruned: 0, total: 3 });
  });

  it('updates positional metadata in place when a chunk moves', () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    order = 0;
    const shifted = [blk('0 Preface', 1, 'heading'), blk('Why this book exists and how to read the chapters.', 1), ...book().map(b => ({ ...b, page: b.page + 1, readingOrder: b.readingOrder + 2 }))];
    const r = syncSourceChunks(db, s.id, chunkBlocks(shifted).chunks);
    expect(r).toEqual({ inserted: 1, updated: 3, deleted: 0, unchanged: 0 });
    const rows = listSourceChunks(db, s.id);
    expect(rows.map(c => c.page_start)).toEqual([1, 2, 3, 4]);
  });

  it('deleteSourceChunks removes rows, FTS entries and vectors; source delete cascades', async () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    await indexSourceChunkEmbeddings(db, fakeEmbedder(), s.id);
    expect(deleteSourceChunks(db, s.id)).toBe(3);
    expect(chunkIndexStats(db, 'fake', s.id)).toEqual({ chunks: 0, sources: 0, embedded: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE rag_chunks_fts MATCH '"induction"'`).get()).toEqual({ n: 0 });

    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    deleteSource(db, s.id);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE rag_chunks_fts MATCH '"induction"'`).get()).toEqual({ n: 0 });
  });

  it('survives clearDerivedDataForSource and concept/span re-indexing', async () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    const emb = fakeEmbedder();
    await indexSourceChunkEmbeddings(db, emb, s.id);
    const c = createConcept(db, {
      source_id: s.id, name: 'Induction', slug: 'induction', importance: 'core', definition_text: 'proof technique',
      why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [], section_path: [],
      exam_value: 0.5, misconception_risk: 0.5, centrality_score: 0.5,
    });
    db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?').run(JSON.stringify([{ kind: 'definition', quote: 'x'.repeat(50), page: 1 }]), c.id);

    // Concept/span indexing (including under another model) must not prune chunk vectors.
    await indexSourceEmbeddings(db, emb, s.id);
    await indexSourceEmbeddings(db, fakeEmbedder('other'), s.id);
    expect(chunkIndexStats(db, 'fake', s.id).embedded).toBe(3);

    clearDerivedDataForSource(db, s.id);
    expect(chunkIndexStats(db, 'fake', s.id)).toEqual({ chunks: 3, sources: 1, embedded: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE owner_kind <> 'chunk'`).get()).toEqual({ n: 0 });
  });
});

describe('chunk embeddings', () => {
  it('embeds incrementally with nomic task prefixes and replaces other-model vectors', async () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    const nomic = fakeEmbedder('nomic-embed-text');
    expect(await indexSourceChunkEmbeddings(db, nomic, s.id)).toEqual({ embedded: 3, pruned: 0, total: 3 });
    expect(nomic.calls[0][0]).toBe('search_document: 1 Induction\n1 Induction\nThe principle of mathematical induction proves a predicate for every natural number using a basis and an induction step.');
    expect(await indexSourceChunkEmbeddings(db, nomic, s.id)).toEqual({ embedded: 0, pruned: 0, total: 3 });
    const other = await indexSourceChunkEmbeddings(db, fakeEmbedder('mxbai'), s.id);
    expect(other).toEqual({ embedded: 3, pruned: 3, total: 3 });
    expect(queryEmbeddingText('nomic-embed-text', 'q')).toBe('search_query: q');
    expect(documentEmbeddingText('mxbai', { text: 't', section_text: '' })).toBe('t');
  });

  it('propagates embedding server failures instead of swallowing them', async () => {
    const { db, s } = seed();
    syncSourceChunks(db, s.id, chunkBlocks(book()).chunks);
    const broken: Embedder = { model: 'x', async embed() { throw new Error('Embedding server at http://127.0.0.1:11434/v1 could not be reached.'); } };
    await expect(indexSourceChunkEmbeddings(db, broken, s.id)).rejects.toThrow(/could not be reached/);
    expect(chunkIndexStats(db, 'x', s.id).embedded).toBe(0);
  });
});
