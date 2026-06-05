import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { createSource } from './repos/sources';
import { createConcept, createEdge } from './repos/concepts';
import { upsertMastery } from './repos/evidence';
import { getConceptPrerequisites, PREREQUISITE_READY_STAGE } from './prerequisites';
import type { CompressionStage } from '../core/domain/types';

type DB = ReturnType<typeof openDb>;

function mk(db: DB, sourceId: number, name: string): number {
  return createConcept(db, {
    source_id: sourceId,
    name,
    slug: name.toLowerCase().replace(/\W+/g, '-'),
    importance: 'core',
    definition_text: '',
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0,
    misconception_risk: 0,
    centrality_score: 0,
  }).id;
}

describe('getConceptPrerequisites', () => {
  it('orders transitive prerequisites learn-first (deepest before shallow)', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const calculus = mk(db, s.id, 'Calculus');
    const gradients = mk(db, s.id, 'Gradients');
    const backprop = mk(db, s.id, 'Backprop');
    // from_id = prerequisite, to_id = dependent.
    createEdge(db, calculus, gradients, 'requires'); // Calculus is required by Gradients
    createEdge(db, gradients, backprop, 'requires');  // Gradients is required by Backprop

    const p = getConceptPrerequisites(db, backprop);
    expect(p.direct.map(n => n.name)).toEqual(['Gradients']);
    expect(p.learnFirst.map(n => n.name)).toEqual(['Calculus', 'Gradients']);
    expect(p.hasCycle).toBe(false);
    db.close();
  });

  it('computes what a concept unlocks (transitive dependents)', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const calculus = mk(db, s.id, 'Calculus');
    const gradients = mk(db, s.id, 'Gradients');
    const backprop = mk(db, s.id, 'Backprop');
    createEdge(db, calculus, gradients, 'requires');
    createEdge(db, gradients, backprop, 'requires');

    const p = getConceptPrerequisites(db, calculus);
    expect(new Set(p.unlocks.map(n => n.name))).toEqual(new Set(['Gradients', 'Backprop']));
    expect(p.learnFirst).toEqual([]); // nothing precedes the root
    db.close();
  });

  it('flags the blocked direct prerequisites by mastery stage', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const gradients = mk(db, s.id, 'Gradients');
    const backprop = mk(db, s.id, 'Backprop');
    createEdge(db, gradients, backprop, 'requires');

    // Unmastered prerequisite => blocked.
    let p = getConceptPrerequisites(db, backprop);
    expect(p.blocked.map(n => n.name)).toEqual(['Gradients']);

    // Reach the ready stage => no longer blocked.
    upsertMastery(db, gradients, PREREQUISITE_READY_STAGE as CompressionStage);
    p = getConceptPrerequisites(db, backprop);
    expect(p.blocked).toEqual([]);
    db.close();
  });

  it('is cycle-safe: returns all nodes and sets hasCycle on a non-DAG', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const q = mk(db, s.id, 'Q');
    const b = mk(db, s.id, 'B');
    const c = mk(db, s.id, 'C');
    createEdge(db, b, q, 'requires'); // B required by Q
    createEdge(db, c, b, 'requires'); // C required by B
    createEdge(db, b, c, 'requires'); // B required by C  -> B<->C cycle

    const p = getConceptPrerequisites(db, q);
    expect(p.hasCycle).toBe(true);
    expect(new Set(p.learnFirst.map(n => n.name))).toEqual(new Set(['B', 'C']));
    db.close();
  });

  it('ignores self-edges entirely', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const a = mk(db, s.id, 'Alpha');
    expect(createEdge(db, a, a, 'requires')).toBeNull(); // guarded away
    const p = getConceptPrerequisites(db, a);
    expect(p.direct).toEqual([]);
    expect(p.learnFirst).toEqual([]);
    expect(p.unlocks).toEqual([]);
    db.close();
  });
});
