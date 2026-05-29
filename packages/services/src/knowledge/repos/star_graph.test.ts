import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept, createEdge, buildConstellationGraph } from './concepts';
import type { ConceptImportance } from '../../core/domain/types';

type DB = ReturnType<typeof openDb>;

function mkConcept(
  db: DB,
  sourceId: number,
  name: string,
  whereReappears: Array<string | { name: string; reason: string }> = [],
  importance: ConceptImportance = 'core',
): number {
  return createConcept(db, {
    source_id: sourceId,
    name,
    slug: name.toLowerCase().replace(/\W+/g, '-'),
    importance,
    definition_text: '',
    why_exists: '',
    what_breaks: '',
    // Stored as JSON; the graph builder reads both bare strings and {name,reason}.
    where_reappears: whereReappears as unknown as string[],
    chunk_ids: [],
    section_path: [],
    exam_value: 0,
    misconception_risk: 0,
    centrality_score: 0,
  }).id;
}

describe('buildConstellationGraph', () => {
  it('classifies one-way vs mutual constellation links and carries the reason', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    // A → B only (one-way); B ↔ C (mutual).
    mkConcept(db, s.id, 'Alpha', [{ name: 'Beta', reason: 'a leads to b' }]);
    mkConcept(db, s.id, 'Beta', [{ name: 'Gamma', reason: 'b ~ c' }]);
    mkConcept(db, s.id, 'Gamma', [{ name: 'Beta', reason: 'c ~ b' }]);

    const g = buildConstellationGraph(db);
    expect(g.nodes.length).toBe(3);

    const byPair = (n1: string, n2: string) => {
      const id = (nm: string) => g.nodes.find(n => n.name === nm)!.id;
      const a = id(n1), b = id(n2);
      return g.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    };

    const ab = byPair('Alpha', 'Beta')!;
    expect(ab.kind).toBe('constellation');
    expect(ab.directed).toBe(true);                 // one-way
    expect(ab.label).toBe('a leads to b');          // reason surfaced
    // direction points Alpha → Beta
    const alpha = g.nodes.find(n => n.name === 'Alpha')!.id;
    const beta = g.nodes.find(n => n.name === 'Beta')!.id;
    expect(ab.a).toBe(alpha);
    expect(ab.b).toBe(beta);

    const bc = byPair('Beta', 'Gamma')!;
    expect(bc.directed).toBe(false);                // mutual

    db.close();
  });

  it('dedupes a pair, preferring a relation edge over a constellation, and counts dupes', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const x = mkConcept(db, s.id, 'X', [{ name: 'Y', reason: 'x links y' }]);
    const y = mkConcept(db, s.id, 'Y');
    createEdge(db, x, y, 'requires');               // same pair as the constellation

    const g = buildConstellationGraph(db);
    const edges = g.edges.filter(e => (e.a === x && e.b === y) || (e.a === y && e.b === x));
    expect(edges.length).toBe(1);                   // collapsed to one
    expect(edges[0].kind).toBe('relation');         // relation wins
    expect(edges[0].label).toBe('requires');
    expect(g.stats.duplicateEdges).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('counts dangling constellations and unresolved relations', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mkConcept(db, s.id, 'Solo', [{ name: 'Nonexistent Concept', reason: 'r' }]);

    const g = buildConstellationGraph(db);
    expect(g.stats.danglingConstellations).toBe(1);
    expect(g.stats.nodeCount).toBe(1);
    expect(g.edges.length).toBe(0);
    db.close();
  });

  it('resolves legacy bare-string links (no reason)', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mkConcept(db, s.id, 'One', ['Two']);            // legacy string form
    mkConcept(db, s.id, 'Two');

    const g = buildConstellationGraph(db);
    expect(g.edges.length).toBe(1);
    expect(g.edges[0].kind).toBe('constellation');
    expect(g.edges[0].label).toBeUndefined();
    db.close();
  });
});
