import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { createSource } from './repos/sources';
import { createConcept } from './repos/concepts';
import { createRelationCandidate } from './repos/candidates';
import { clearDerivedDataForSource } from './cleanup';
import { getConceptPrerequisites } from './prerequisites';
import {
  deriveEdgeFromRelation,
  computeDeterministicSuggestions,
  listPrerequisiteSuggestions,
  acceptPrerequisiteSuggestion,
  rejectPrerequisiteSuggestion,
  clearPrerequisiteSuggestionsForSource,
} from './prerequisite_suggestions';

type DB = ReturnType<typeof openDb>;

function mk(db: DB, sourceId: number, name: string): number {
  return createConcept(db, {
    source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'),
    importance: 'core', definition_text: '', why_exists: '', what_breaks: '',
    where_reappears: [], chunk_ids: [], section_path: [],
    exam_value: 0, misconception_risk: 0, centrality_score: 0,
  }).id;
}

function edgeCount(db: DB): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM concept_edges').get() as { c: number }).c);
}

describe('deriveEdgeFromRelation (direction contract)', () => {
  const names = new Map<string, number>([['a', 1], ['b', 2]]);

  it('"A requires B" => B is the prerequisite (from_id=B, to_id=A), flipped', () => {
    const e = deriveEdgeFromRelation({ from: 'A', to: 'B', kind: 'requires' }, names);
    expect(e).toEqual({ fromId: 2, toId: 1, edgeType: 'requires', reason: '' });
  });

  it('"A enables B" => A is the prerequisite (from_id=A, to_id=B), not flipped', () => {
    const e = deriveEdgeFromRelation({ from: 'A', to: 'B', kind: 'enables' }, names);
    expect(e).toEqual({ fromId: 1, toId: 2, edgeType: 'enables', reason: '' });
  });

  it('ignores non-dependency relation kinds', () => {
    expect(deriveEdgeFromRelation({ from: 'A', to: 'B', kind: 'causes' }, names)).toBeNull();
    expect(deriveEdgeFromRelation({ from: 'A', to: 'B', kind: 'example_of' }, names)).toBeNull();
  });

  it('returns null when an endpoint does not resolve to a promoted concept', () => {
    expect(deriveEdgeFromRelation({ from: 'A', to: 'Zzz', kind: 'requires' }, names)).toBeNull();
  });

  it('returns null for a self-edge (both endpoints resolve to the same concept)', () => {
    const same = new Map<string, number>([['a', 7], ['b', 7]]);
    expect(deriveEdgeFromRelation({ from: 'A', to: 'B', kind: 'requires' }, same)).toBeNull();
  });
});

describe('computeDeterministicSuggestions', () => {
  it('resolves a requires relation to a directed suggestion (no edge written yet)', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const bp = mk(db, s.id, 'Backpropagation');
    const cr = mk(db, s.id, 'Chain Rule');
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'chain rule', kind: 'requires',
      quote: 'Backpropagation requires the chain rule.', page: 4,
    });

    const res = computeDeterministicSuggestions(db, s.id);
    expect(res.created).toBe(1);
    expect(edgeCount(db)).toBe(0); // suggestion only — never auto-writes an edge

    const [sug] = listPrerequisiteSuggestions(db, s.id);
    expect(sug.from_id).toBe(cr);  // Chain Rule is the prerequisite
    expect(sug.to_id).toBe(bp);    // Backpropagation depends on it
    expect(sug.from_name).toBe('Chain Rule');
    expect(sug.to_name).toBe('Backpropagation');
    expect(sug.edge_type).toBe('requires');
    expect(sug.basis).toBe('deterministic');
    db.close();
  });

  it('skips relations whose endpoints are not both promoted concepts', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mk(db, s.id, 'Backpropagation');
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'some unpromoted term', kind: 'requires', quote: 'q', page: 1,
    });
    const res = computeDeterministicSuggestions(db, s.id);
    expect(res.created).toBe(0);
    expect(res.skippedUnresolved).toBe(1);
    expect(listPrerequisiteSuggestions(db, s.id)).toEqual([]);
    db.close();
  });

  it('accept writes a user-curated edge and feeds traversal; recompute does not duplicate', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const bp = mk(db, s.id, 'Backpropagation');
    const cr = mk(db, s.id, 'Chain Rule');
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'chain rule', kind: 'requires', quote: 'q', page: 1,
    });
    computeDeterministicSuggestions(db, s.id);
    const [sug] = listPrerequisiteSuggestions(db, s.id);

    const accepted = acceptPrerequisiteSuggestion(db, sug.id);
    expect(accepted?.status).toBe('accepted');
    expect(edgeCount(db)).toBe(1);
    // The accepted edge now powers prerequisite traversal.
    const p = getConceptPrerequisites(db, bp);
    expect(p.direct.map(n => n.id)).toEqual([cr]);

    // Recomputing finds the edge already exists -> no new suggestion, no dupe edge.
    const res2 = computeDeterministicSuggestions(db, s.id);
    expect(res2.created).toBe(0);
    expect(res2.skippedExistingEdge).toBe(1);
    expect(edgeCount(db)).toBe(1);
    db.close();
  });

  it('reject dismisses a suggestion and recompute never resurrects it', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mk(db, s.id, 'Backpropagation');
    mk(db, s.id, 'Chain Rule');
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'chain rule', kind: 'requires', quote: 'q', page: 1,
    });
    computeDeterministicSuggestions(db, s.id);
    const [sug] = listPrerequisiteSuggestions(db, s.id);
    rejectPrerequisiteSuggestion(db, sug.id);

    expect(listPrerequisiteSuggestions(db, s.id, 'pending')).toEqual([]);
    expect(listPrerequisiteSuggestions(db, s.id, 'dismissed').length).toBe(1);

    const res2 = computeDeterministicSuggestions(db, s.id);
    expect(res2.created).toBe(0); // INSERT OR IGNORE keeps the dismissed row
    expect(listPrerequisiteSuggestions(db, s.id, 'pending')).toEqual([]);
    db.close();
  });
});

describe('suggestion cleanup vs accepted edges', () => {
  it('clears suggestions but leaves user-curated edges intact', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const bp = mk(db, s.id, 'Backpropagation');
    const cr = mk(db, s.id, 'Chain Rule');
    // Mark both concepts promoted (non-empty evidence_json) so a re-extract
    // preserves them — proving the accepted edge survives the suggestion wipe.
    db.prepare("UPDATE concepts SET evidence_json = '[{\"source\":\"x\",\"page\":1}]' WHERE source_id = ?").run(s.id);
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'chain rule', kind: 'requires', quote: 'q', page: 1,
    });
    computeDeterministicSuggestions(db, s.id);
    const [sug] = listPrerequisiteSuggestions(db, s.id);
    acceptPrerequisiteSuggestion(db, sug.id);

    const counts = clearDerivedDataForSource(db, s.id);
    expect(counts.prerequisite_suggestions).toBeGreaterThanOrEqual(1);
    expect(counts.concepts_preserved).toBe(2);

    // Suggestions gone; concept_edges survives; traversal still works.
    expect(listPrerequisiteSuggestions(db, s.id, 'accepted')).toEqual([]);
    expect(edgeCount(db)).toBe(1);
    expect(getConceptPrerequisites(db, bp).direct.map(n => n.id)).toEqual([cr]);
    db.close();
  });

  it('clearPrerequisiteSuggestionsForSource removes only suggestions', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mk(db, s.id, 'Backpropagation');
    mk(db, s.id, 'Chain Rule');
    createRelationCandidate(db, s.id, {
      from: 'Backpropagation', to: 'chain rule', kind: 'requires', quote: 'q', page: 1,
    });
    computeDeterministicSuggestions(db, s.id);
    const removed = clearPrerequisiteSuggestionsForSource(db, s.id);
    expect(removed).toBe(1);
    expect(listPrerequisiteSuggestions(db, s.id)).toEqual([]);
    db.close();
  });
});
