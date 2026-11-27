// Prerequisite-suggestion rejections are keyed on the concepts' stable
// identity (source + slug), not database ids: a concept deleted and recreated
// (new id) still matches, and an unrelated concept never does.
import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { DatabaseSync } from '../core/infra/sqlite';
import { createSource } from './repos/sources';
import { createConcept, deleteConcept, getConceptBySlug } from './repos/concepts';
import { createRelationCandidate } from './repos/candidates';
import { listRejections, undoRejection } from './repos/rejections';
import { clearDerivedDataForSource } from './cleanup';
import {
  computeDeterministicSuggestions, listPrerequisiteSuggestions, rejectPrerequisiteSuggestion,
} from './prerequisite_suggestions';

function concept(db: DatabaseSync, sourceId: number, name: string) {
  return createConcept(db, {
    source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'), importance: 'core',
    definition_text: '', why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
    section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
  }, 'promoted');
}

// Momentum requires Gradient Descent  =>  suggestion GD -> Momentum.
function setup() {
  const db = openDb(':memory:');
  const sourceId = createSource(db, { filename: 'x.txt', file_path: 'x.txt' }).id;
  const gd = concept(db, sourceId, 'Gradient Descent');
  const mom = concept(db, sourceId, 'Momentum');
  createRelationCandidate(db, sourceId, { from: 'Momentum', to: 'Gradient Descent', kind: 'requires', quote: '', page: 1 });
  computeDeterministicSuggestions(db, sourceId);
  const [sug] = listPrerequisiteSuggestions(db, sourceId, 'pending');
  rejectPrerequisiteSuggestion(db, sug.id);
  return { db, sourceId, gd, mom };
}
const pending = (db: DatabaseSync, s: number) => listPrerequisiteSuggestions(db, s, 'pending');
const dismissed = (db: DatabaseSync, s: number) => listPrerequisiteSuggestions(db, s, 'dismissed');

describe('prerequisite rejection identity', () => {
  it('records the stable identity, not database ids', () => {
    const { db, sourceId } = setup();
    expect(listRejections(db, sourceId)[0].identity_key).toBe(`${sourceId}:gradient-descent>${sourceId}:momentum|requires`);
    db.close();
  });

  it('still matches after both concepts are deleted and recreated with new ids', () => {
    const { db, sourceId, gd, mom } = setup();
    clearDerivedDataForSource(db, sourceId);        // wipes suggestions, as re-extract does
    deleteConcept(db, gd.id);
    deleteConcept(db, mom.id);
    const gd2 = concept(db, sourceId, 'Gradient Descent');
    const mom2 = concept(db, sourceId, 'Momentum');
    expect([gd2.id, mom2.id]).not.toContain(gd.id);
    expect([gd2.id, mom2.id]).not.toContain(mom.id);

    computeDeterministicSuggestions(db, sourceId);

    expect(pending(db, sourceId)).toEqual([]);
    expect(dismissed(db, sourceId).map(s => [s.from_id, s.to_id])).toEqual([[gd2.id, mom2.id]]);
    db.close();
  });

  it('undo after recreation resolves the endpoints to their new ids', () => {
    const { db, sourceId, gd, mom } = setup();
    clearDerivedDataForSource(db, sourceId);
    deleteConcept(db, gd.id);
    deleteConcept(db, mom.id);
    concept(db, sourceId, 'Gradient Descent');
    concept(db, sourceId, 'Momentum');
    computeDeterministicSuggestions(db, sourceId);

    expect(undoRejection(db, listRejections(db, sourceId)[0].id)).toBe(true);
    expect(pending(db, sourceId)).toHaveLength(1);
    expect(listRejections(db, sourceId)).toEqual([]);
    db.close();
  });

  it('a rename keeps the match (slug is unchanged)', () => {
    const { db, sourceId, mom } = setup();
    db.prepare(`UPDATE concepts SET name = 'Heavy-ball Momentum' WHERE id = ?`).run(mom.id);
    clearDerivedDataForSource(db, sourceId);
    createRelationCandidate(db, sourceId, { from: 'Heavy-ball Momentum', to: 'Gradient Descent', kind: 'requires', quote: '', page: 1 });
    computeDeterministicSuggestions(db, sourceId);
    expect(pending(db, sourceId)).toEqual([]);
    expect(dismissed(db, sourceId)).toHaveLength(1);
    db.close();
  });

  it('a different concept pair is not matched', () => {
    const { db, sourceId } = setup();
    concept(db, sourceId, 'Nesterov');
    createRelationCandidate(db, sourceId, { from: 'Nesterov', to: 'Gradient Descent', kind: 'requires', quote: '', page: 1 });
    computeDeterministicSuggestions(db, sourceId);
    const nesterov = getConceptBySlug(db, sourceId, 'nesterov')!;
    expect(pending(db, sourceId).map(s => s.to_id)).toEqual([nesterov.id]);
    db.close();
  });

  it('is source-scoped: the same slugs in another source are not matched', () => {
    const { db } = setup();
    const other = createSource(db, { filename: 'y.txt', file_path: 'y.txt' }).id;
    concept(db, other, 'Gradient Descent');
    concept(db, other, 'Momentum');
    createRelationCandidate(db, other, { from: 'Momentum', to: 'Gradient Descent', kind: 'requires', quote: '', page: 1 });
    computeDeterministicSuggestions(db, other);
    expect(pending(db, other)).toHaveLength(1);
    db.close();
  });
});
