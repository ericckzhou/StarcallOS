// A rejection applies to a parser identity, not to one row: rejecting one of
// several identical parser outputs removes all of them, and undo restores all.
import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { DatabaseSync } from '../core/infra/sqlite';
import type { RelationCandidate } from '../ingestion/candidates';
import { createSource } from './repos/sources';
import {
  createMisconceptionCandidate, createRelationCandidate, listMisconceptionCandidatesBySource,
  listRelationCandidatesBySource, persistCandidateExtraction,
} from './repos/candidates';
import { listRejections, rejectMisconceptionCandidate, rejectRelationCandidate, undoRejection } from './repos/rejections';

const rel = (quote: string): RelationCandidate => ({ from: 'A', to: 'B', kind: 'requires', quote, page: 1 }) as RelationCandidate;
const mis = (quote: string) => ({ quote, page: 2, section_path: [] as string[] });

function setup() {
  const db = openDb(':memory:');
  const sourceId = createSource(db, { filename: 'x.txt', file_path: 'x.txt' }).id;
  const reextract = (relations: RelationCandidate[], phrases: Array<ReturnType<typeof mis>> = []) =>
    persistCandidateExtraction(db, sourceId, { candidates: [], relations, misconception_phrases: phrases, equations: [] });
  const relQuotes = () => listRelationCandidatesBySource(db, sourceId).map(r => r.quote).sort();
  const misQuotes = () => listMisconceptionCandidatesBySource(db, sourceId).map(m => m.quote).sort();
  return { db, sourceId, reextract, relQuotes, misQuotes };
}
const origins = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT origin FROM ${table} ORDER BY id`).all() as Array<{ origin: string | null }>).map(r => r.origin);

describe('rejecting one of several identical parser outputs', () => {
  it('relations: removes all of them, keeps them out on re-extract, and undo restores all', () => {
    const { db, sourceId, reextract, relQuotes } = setup();
    const twice = [rel('same quote'), rel('same quote'), rel('other quote')];
    reextract(twice);
    expect(relQuotes()).toEqual(['other quote', 'same quote', 'same quote']);

    rejectRelationCandidate(db, listRelationCandidatesBySource(db, sourceId).find(r => r.quote === 'same quote')!.id);
    expect(relQuotes()).toEqual(['other quote']);
    reextract(twice);
    reextract(twice);
    expect(relQuotes()).toEqual(['other quote']);

    const [rec] = listRejections(db, sourceId);
    undoRejection(db, rec.id);
    expect(relQuotes()).toEqual(['other quote', 'same quote', 'same quote']);
    expect(origins(db, 'relation_candidates')).toEqual(['parser', 'parser', 'parser']);
    // Restored rows carry their identity, so re-extract does not add more.
    reextract(twice);
    expect(relQuotes()).toEqual(['other quote', 'same quote', 'same quote']);
    db.close();
  });

  it('misconceptions: removes all of them and undo restores all', () => {
    const { db, sourceId, reextract, misQuotes } = setup();
    const twice = [mis('bigger is faster'), mis('bigger is faster')];
    reextract([], twice);
    rejectMisconceptionCandidate(db, listMisconceptionCandidatesBySource(db, sourceId)[0].id);
    expect(misQuotes()).toEqual([]);
    reextract([], twice);
    expect(misQuotes()).toEqual([]);
    undoRejection(db, listRejections(db, sourceId)[0].id);
    expect(misQuotes()).toEqual(['bigger is faster', 'bigger is faster']);
    db.close();
  });

  it('an edited row sharing the identity is removed with it and restored with its edit', () => {
    const { db, sourceId, reextract, relQuotes } = setup();
    reextract([rel('q'), rel('q')]);
    const [first] = listRelationCandidatesBySource(db, sourceId);
    db.prepare(`UPDATE relation_candidates SET quote = 'q (edited)', user_modified_at = datetime('now') WHERE id = ?`).run(first.id);
    rejectRelationCandidate(db, listRelationCandidatesBySource(db, sourceId).find(r => r.quote === 'q')!.id);
    expect(relQuotes()).toEqual([]);
    undoRejection(db, listRejections(db, sourceId)[0].id);
    expect(relQuotes()).toEqual(['q', 'q (edited)']);
    db.close();
  });

  it('never matches user-created or unknown-origin rows with identical content', () => {
    const { db, sourceId, reextract, relQuotes } = setup();
    reextract([rel('same quote')]);
    createRelationCandidate(db, sourceId, rel('same quote'));                        // user-created copy
    db.prepare(`INSERT INTO relation_candidates (source_id, from_term, to_term, relation_kind, quote, page)
                VALUES (?, 'A', 'B', 'requires', 'same quote', 1)`).run(sourceId);  // legacy, origin NULL
    rejectRelationCandidate(db, listRelationCandidatesBySource(db, sourceId).find(r => r.quote === 'same quote')!.id);
    // The parser row is gone; the user's and the legacy row are untouched.
    expect(relQuotes()).toEqual(['same quote', 'same quote']);
    expect(origins(db, 'relation_candidates')).toEqual(['user', null]);
    db.close();
  });

  it('a second rejection of an already-rejected identity extends the snapshot, so undo restores both', () => {
    const { db, sourceId, reextract, misQuotes } = setup();
    reextract([], [mis('m')]);
    rejectMisconceptionCandidate(db, listMisconceptionCandidatesBySource(db, sourceId)[0].id);
    // A parser row with the same identity appears again (e.g. restored by a
    // stale UI action) and is rejected again.
    createMisconceptionCandidate(db, sourceId, mis('m'), 'parser');
    rejectMisconceptionCandidate(db, listMisconceptionCandidatesBySource(db, sourceId)[0].id);
    expect(listRejections(db, sourceId)).toHaveLength(1);
    undoRejection(db, listRejections(db, sourceId)[0].id);
    expect(misQuotes()).toEqual(['m', 'm']);
    db.close();
  });
});
