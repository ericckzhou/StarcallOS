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
  whereReappears: Array<string | { name: string; reason: string; targetId?: number }> = [],
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

  it('resolves a link by targetId even when the stored name no longer matches (rename-proof)', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const two = mkConcept(db, s.id, 'Renamed Concept');
    // The link still carries the OLD name but the stable targetId — simulating a
    // rename of the target after the link was made.
    mkConcept(db, s.id, 'One', [{ name: 'Old Name', reason: 'r', targetId: two }]);

    const g = buildConstellationGraph(db);
    expect(g.stats.danglingConstellations).toBe(0);
    expect(g.edges.length).toBe(1);
    const one = g.nodes.find(n => n.name === 'One')!.id;
    const edge = g.edges[0];
    expect((edge.a === one && edge.b === two) || (edge.a === two && edge.b === one)).toBe(true);
    db.close();
  });

  it('uses targetId to disambiguate a name shared across sources', () => {
    const db = openDb(':memory:');
    const sa = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const sb = createSource(db, { filename: 'b.pdf', file_path: 'b.pdf' });
    const dupA = mkConcept(db, sa.id, 'Dup');
    const dupB = mkConcept(db, sb.id, 'Dup');
    // Link explicitly to the source-B 'Dup' by id, despite the name collision.
    mkConcept(db, sa.id, 'Linker', [{ name: 'Dup', reason: 'r', targetId: dupB }]);

    const g = buildConstellationGraph(db);
    const linker = g.nodes.find(n => n.name === 'Linker')!.id;
    const edges = g.edges.filter(e => e.a === linker || e.b === linker);
    expect(edges.length).toBe(1);
    const other = edges[0].a === linker ? edges[0].b : edges[0].a;
    expect(other).toBe(dupB);
    expect(other).not.toBe(dupA);
    db.close();
  });

  it('falls back to name resolution when targetId points at a deleted concept', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mkConcept(db, s.id, 'Two');
    // targetId 999999 does not exist, but the name 'Two' still resolves.
    mkConcept(db, s.id, 'One', [{ name: 'Two', reason: 'r', targetId: 999999 }]);

    const g = buildConstellationGraph(db);
    expect(g.stats.danglingConstellations).toBe(0);
    expect(g.edges.length).toBe(1);
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
