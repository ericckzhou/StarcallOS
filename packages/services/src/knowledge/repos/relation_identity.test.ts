// Relation reconciliation identity on re-extract: parser-origin rows match
// only their full original identity (quote included); the coarse identity
// (page + endpoints + kind) is a fallback for user-created rows only.
import { describe, it, expect } from 'vitest';
import { openDb } from '../../core/infra/db';
import type { DatabaseSync } from '../../core/infra/sqlite';
import type { RelationCandidate } from '../../ingestion/candidates';
import { createSource } from './sources';
import {
  createRelationCandidate, listRelationCandidatesBySource, persistCandidateExtraction, relationKey,
  updateRelationCandidate,
} from './candidates';

const rel = (quote: string, over: Partial<RelationCandidate> = {}): RelationCandidate =>
  ({ from: 'A', to: 'B', kind: 'requires', quote, page: 1, ...over }) as RelationCandidate;

function setup() {
  const db = openDb(':memory:');
  const sourceId = createSource(db, { filename: 'x.txt', file_path: 'x.txt' }).id;
  const reextract = (relations: RelationCandidate[]) =>
    persistCandidateExtraction(db, sourceId, { candidates: [], relations, misconception_phrases: [], equations: [] });
  const quotes = () => listRelationCandidatesBySource(db, sourceId).map(r => `${r.to}:${r.quote}`).sort();
  const byQuote = (q: string) => listRelationCandidatesBySource(db, sourceId).find(r => r.quote === q)!;
  return { db, sourceId, reextract, quotes, byQuote };
}
const edit = (db: DatabaseSync, id: number, quote: string) =>
  updateRelationCandidate(db, id, { from: 'A', to: 'B', kind: 'requires', quote, page: 1 });

describe('relation identity', () => {
  it('source_key is the full identity and is deterministic', () => {
    const { db, reextract, byQuote } = setup();
    reextract([rel('first quote')]);
    const row = db.prepare('SELECT source_key FROM relation_candidates').get() as { source_key: string };
    expect(row.source_key).toBe(relationKey(rel('first quote')));
    expect(relationKey(rel('  First   QUOTE '))).toBe(relationKey(rel('first quote')));
    expect(byQuote('first quote')).toBeDefined();
    db.close();
  });

  const SHARED = [rel('first quote'), rel('second quote')];

  it.each([['first'], ['second']])('editing the %s of two candidates sharing the coarse identity keeps both correctly', (which) => {
    const { db, reextract, quotes, byQuote } = setup();
    reextract(SHARED);
    edit(db, byQuote(`${which} quote`).id, `${which} quote (edited)`);
    reextract(SHARED);
    reextract(SHARED);
    const other = which === 'first' ? 'second' : 'first';
    expect(quotes()).toEqual([`B:${other} quote`, `B:${which} quote (edited)`].sort());
    db.close();
  });

  it('repeated identical parser output is kept as a multiset', () => {
    const { db, reextract, quotes } = setup();
    const twice = [rel('same quote'), rel('same quote')];
    reextract(twice);
    reextract(twice);
    expect(quotes()).toEqual(['B:same quote', 'B:same quote']);
    const [first] = listRelationCandidatesBySource(db, 1);
    edit(db, first.id, 'same quote (edited)');
    reextract(twice);
    expect(quotes()).toEqual(['B:same quote', 'B:same quote (edited)']);
    db.close();
  });

  it('a quote-only change in parser output keeps the edit AND adds the new parser output', () => {
    const { db, reextract, quotes, byQuote } = setup();
    reextract([rel('old quote')]);
    edit(db, byQuote('old quote').id, 'my wording');
    reextract([rel('new quote')]);
    expect(quotes()).toEqual(['B:my wording', 'B:new quote']);
    db.close();
  });

  it('a materially changed parser output keeps the edit and adds the new output', () => {
    const { db, reextract, quotes, byQuote } = setup();
    reextract([rel('q')]);
    edit(db, byQuote('q').id, 'q (edited)');
    reextract([rel('q', { to: 'C' })]);
    expect(quotes()).toEqual(['B:q (edited)', 'C:q']);
    db.close();
  });

  it('an unedited parser row whose quote changed is replaced, not kept beside the new one', () => {
    const { reextract, quotes, db } = setup();
    reextract([rel('old quote')]);
    reextract([rel('new quote')]);
    expect(quotes()).toEqual(['B:new quote']);
    db.close();
  });

  it('a user-created copy of parser output (any quote) is not duplicated', () => {
    const { db, sourceId, reextract, quotes } = setup();
    createRelationCandidate(db, sourceId, rel(''));            // user, empty quote
    reextract([rel('parser quote')]);
    reextract([rel('parser quote')]);
    expect(quotes()).toEqual(['B:']);
    db.close();
  });

  it('a user-created copy absorbs only one of two parser outputs sharing the coarse identity', () => {
    const { db, sourceId, reextract, quotes } = setup();
    createRelationCandidate(db, sourceId, rel('mine'));
    reextract(SHARED);
    expect(quotes()).toEqual(['B:mine', 'B:second quote']);
    db.close();
  });

  it('an unknown-origin legacy row matches only its exact content (no coarse fallback)', () => {
    const { db, sourceId, reextract, quotes } = setup();
    reextract([rel('legacy quote')]);
    db.prepare('UPDATE relation_candidates SET origin = NULL, source_key = NULL WHERE source_id = ?').run(sourceId);
    reextract([rel('legacy quote')]);
    expect(quotes()).toEqual(['B:legacy quote']);            // exact: not duplicated
    reextract([rel('reworded quote')]);
    expect(quotes()).toEqual(['B:legacy quote', 'B:reworded quote']); // kept + new, never merged by guess
    db.close();
  });
});
