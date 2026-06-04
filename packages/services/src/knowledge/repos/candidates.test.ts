import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept } from './concepts';
import {
  createConceptCandidate,
  listConceptCandidatesBySource,
  getConceptCandidateById,
  deleteConceptCandidate,
  createRelationCandidate,
  listRelationCandidatesBySource,
  updateRelationCandidate,
  deleteRelationCandidate,
  createMisconceptionCandidate,
  listMisconceptionCandidatesBySource,
  updateMisconceptionCandidate,
  deleteMisconceptionCandidate,
  createEquationCandidate,
  createEquationCandidateForSource,
  createManualEquationForConcept,
  updateEquationCandidate,
  deleteEquationCandidate,
  listEquationCandidatesBySource,
  listEquationCandidatesForConcept,
  clearCandidatesForSource,
  persistCandidateExtraction,
} from './candidates';
import type { ConceptCandidate, EvidenceSpan } from '../../ingestion/candidates';

function db() {
  return openDb(':memory:');
}

function seedSource(database: ReturnType<typeof openDb>): number {
  return createSource(database, { filename: 'b.pdf', file_path: 'b.pdf' }).id;
}

function candidate(
  over: { term: string; normalized: string } & Partial<ConceptCandidate>,
): ConceptCandidate {
  const evidence: EvidenceSpan[] = over.evidence ?? [{ source: 'heading', quote: 'q', page: 1 }];
  return {
    term: over.term,
    normalized: over.normalized,
    confidence: over.confidence ?? 0.8,
    evidence,
    section_path: over.section_path ?? [],
    first_page: over.first_page ?? 1,
    mention_count: over.mention_count ?? 1,
    topic_relevance_score: over.topic_relevance_score ?? 1,
    topic_relevance_reasons: over.topic_relevance_reasons ?? [],
    is_boilerplate: over.is_boilerplate ?? false,
    is_broad: over.is_broad ?? false,
    concept_score: over.concept_score ?? 0.5,
    final_score: over.final_score,
    reject_reasons: over.reject_reasons ?? [],
  };
}

function mkConcept(database: ReturnType<typeof openDb>, sourceId: number, name: string): number {
  return createConcept(database, {
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
    centrality_score: 0.5,
  }).id;
}

describe('concept candidates', () => {
  it('round-trips a candidate and derives deduped signals from evidence sources', () => {
    const d = db();
    const sourceId = seedSource(d);

    createConceptCandidate(d, sourceId, candidate({
      term: 'Gradient Descent',
      normalized: 'gradient descent',
      section_path: ['Ch 1'],
      evidence: [
        { source: 'heading', quote: 'a', page: 2 },
        { source: 'heading', quote: 'b', page: 3 },
        { source: 'definition_pattern', quote: 'c', page: 3 },
      ],
    }));

    const [row] = listConceptCandidatesBySource(d, sourceId);
    expect(row.term).toBe('Gradient Descent');
    expect(row.normalized).toBe('gradient descent');
    expect(row.section_path).toEqual(['Ch 1']);
    expect(row.signals.sort()).toEqual(['definition_pattern', 'heading']);
    d.close();
  });

  it('orders candidates by final_score descending', () => {
    const d = db();
    const sourceId = seedSource(d);
    createConceptCandidate(d, sourceId, candidate({ term: 'Low', normalized: 'low', final_score: 0.2 }));
    createConceptCandidate(d, sourceId, candidate({ term: 'High', normalized: 'high', final_score: 0.9 }));
    createConceptCandidate(d, sourceId, candidate({ term: 'Mid', normalized: 'mid', final_score: 0.5 }));

    const rows = listConceptCandidatesBySource(d, sourceId);
    expect(rows.map(r => r.term)).toEqual(['High', 'Mid', 'Low']);
    d.close();
  });

  it('falls back final_score to concept_score when not provided', () => {
    const d = db();
    const sourceId = seedSource(d);
    createConceptCandidate(d, sourceId, candidate({ term: 'X', normalized: 'x', concept_score: 0.7 }));

    expect(listConceptCandidatesBySource(d, sourceId)[0].final_score).toBe(0.7);
    d.close();
  });

  it('gets a candidate by id and returns null for a missing id', () => {
    const d = db();
    const sourceId = seedSource(d);
    createConceptCandidate(d, sourceId, candidate({ term: 'X', normalized: 'x' }));
    const id = listConceptCandidatesBySource(d, sourceId)[0].id;

    expect(getConceptCandidateById(d, id)?.term).toBe('X');
    expect(getConceptCandidateById(d, 9999)).toBeNull();
    d.close();
  });

  it('deletes a candidate', () => {
    const d = db();
    const sourceId = seedSource(d);
    createConceptCandidate(d, sourceId, candidate({ term: 'X', normalized: 'x' }));
    const id = listConceptCandidatesBySource(d, sourceId)[0].id;

    deleteConceptCandidate(d, id);
    expect(listConceptCandidatesBySource(d, sourceId)).toHaveLength(0);
    d.close();
  });
});

describe('relation candidates', () => {
  it('creates, lists, updates, and deletes', () => {
    const d = db();
    const sourceId = seedSource(d);
    const created = createRelationCandidate(d, sourceId, {
      from: 'Backprop', to: 'chain rule', kind: 'requires', quote: 'Backprop requires the chain rule.', page: 4,
    });
    expect(listRelationCandidatesBySource(d, sourceId)).toHaveLength(1);

    const updated = updateRelationCandidate(d, created.id, { from: 'Backpropagation', to: 'derivatives', kind: 'causes' });
    expect(updated.from).toBe('Backpropagation');
    expect(updated.kind).toBe('causes');

    deleteRelationCandidate(d, created.id);
    expect(listRelationCandidatesBySource(d, sourceId)).toHaveLength(0);
    d.close();
  });

  it('rejects empty endpoints on update', () => {
    const d = db();
    const sourceId = seedSource(d);
    const created = createRelationCandidate(d, sourceId, {
      from: 'A', to: 'B', kind: 'requires', quote: 'q', page: 1,
    });
    expect(() => updateRelationCandidate(d, created.id, { from: '  ', to: 'B', kind: 'requires' })).toThrow();
    d.close();
  });
});

describe('misconception candidates', () => {
  it('creates (trimming the quote), lists, updates, and deletes', () => {
    const d = db();
    const sourceId = seedSource(d);
    const created = createMisconceptionCandidate(d, sourceId, {
      quote: '  students think dropout slows training  ', page: 7, section_path: ['Ch 2'],
    });
    expect(created.quote).toBe('students think dropout slows training');
    expect(listMisconceptionCandidatesBySource(d, sourceId)).toHaveLength(1);

    const updated = updateMisconceptionCandidate(d, created.id, { quote: 'corrected', page: 8 });
    expect(updated.quote).toBe('corrected');
    expect(updated.page).toBe(8);

    deleteMisconceptionCandidate(d, created.id);
    expect(listMisconceptionCandidatesBySource(d, sourceId)).toHaveLength(0);
    d.close();
  });

  it('rejects an empty phrase', () => {
    const d = db();
    const sourceId = seedSource(d);
    expect(() => createMisconceptionCandidate(d, sourceId, { quote: '   ', page: 1, section_path: [] })).toThrow();
    d.close();
  });
});

describe('equation candidates', () => {
  it('lists by source ordered by reading order', () => {
    const d = db();
    const sourceId = seedSource(d);
    createEquationCandidate(d, sourceId, {
      latex: 'b = 2', variables: ['b'], page: 1, reading_order: 5, section_path: [], attached_term: null,
    });
    createEquationCandidate(d, sourceId, {
      latex: 'a = 1', variables: ['a'], page: 1, reading_order: 1, section_path: [], attached_term: null,
    });

    expect(listEquationCandidatesBySource(d, sourceId).map(e => e.latex)).toEqual(['a = 1', 'b = 2']);
    d.close();
  });

  it('infers variables and normalizes attached_term when adding for a source', () => {
    const d = db();
    const sourceId = seedSource(d);
    const eq = createEquationCandidateForSource(d, {
      sourceId, latex: 'E = m c', attached_term: 'Gradient Descent!',
    });
    expect(eq.variables).toEqual(expect.arrayContaining(['E', 'm', 'c']));
    expect(eq.attached_term).toBe('gradient descent');
    d.close();
  });

  it('rejects empty latex', () => {
    const d = db();
    const sourceId = seedSource(d);
    expect(() => createEquationCandidateForSource(d, { sourceId, latex: '   ' })).toThrow();
    d.close();
  });

  it('updates an equation and throws for a missing id', () => {
    const d = db();
    const sourceId = seedSource(d);
    const eq = createEquationCandidateForSource(d, { sourceId, latex: 'a = 1' });
    const updated = updateEquationCandidate(d, eq.id, { latex: 'a = 2', page: 3 });
    expect(updated.latex).toBe('a = 2');
    expect(updated.page).toBe(3);
    expect(() => updateEquationCandidate(d, 9999, { latex: 'x = 0' })).toThrow();
    d.close();
  });

  it('deletes an equation', () => {
    const d = db();
    const sourceId = seedSource(d);
    const eq = createEquationCandidateForSource(d, { sourceId, latex: 'a = 1' });
    deleteEquationCandidate(d, eq.id);
    expect(listEquationCandidatesBySource(d, sourceId)).toHaveLength(0);
    d.close();
  });

  it('attaches a manual equation to a concept and lists it back by concept', () => {
    const d = db();
    const sourceId = seedSource(d);
    const conceptId = mkConcept(d, sourceId, 'Gradient Descent');

    const eq = createManualEquationForConcept(d, { conceptId, latex: '\\theta = \\theta - \\alpha g' });
    expect(eq.attached_term).toBe('gradient descent');

    const forConcept = listEquationCandidatesForConcept(d, conceptId);
    expect(forConcept.map(e => e.id)).toContain(eq.id);
    d.close();
  });

  it('returns no equations for a concept that has none and throws for a missing concept', () => {
    const d = db();
    const sourceId = seedSource(d);
    const conceptId = mkConcept(d, sourceId, 'Lonely Concept');
    expect(listEquationCandidatesForConcept(d, conceptId)).toEqual([]);
    expect(listEquationCandidatesForConcept(d, 9999)).toEqual([]);
    expect(() => createManualEquationForConcept(d, { conceptId: 9999, latex: 'x = 0' })).toThrow();
    d.close();
  });
});

describe('idempotency and bulk persistence', () => {
  it('clearCandidatesForSource wipes every candidate kind for the source', () => {
    const d = db();
    const sourceId = seedSource(d);
    createConceptCandidate(d, sourceId, candidate({ term: 'X', normalized: 'x' }));
    createRelationCandidate(d, sourceId, { from: 'A', to: 'B', kind: 'requires', quote: 'q', page: 1 });
    createMisconceptionCandidate(d, sourceId, { quote: 'm', page: 1, section_path: [] });
    createEquationCandidateForSource(d, { sourceId, latex: 'a = 1' });

    clearCandidatesForSource(d, sourceId);

    expect(listConceptCandidatesBySource(d, sourceId)).toHaveLength(0);
    expect(listRelationCandidatesBySource(d, sourceId)).toHaveLength(0);
    expect(listMisconceptionCandidatesBySource(d, sourceId)).toHaveLength(0);
    expect(listEquationCandidatesBySource(d, sourceId)).toHaveLength(0);
    d.close();
  });

  it('persistCandidateExtraction clears then writes all kinds', () => {
    const d = db();
    const sourceId = seedSource(d);
    // Pre-existing row should be cleared by the persist.
    createConceptCandidate(d, sourceId, candidate({ term: 'Stale', normalized: 'stale' }));

    persistCandidateExtraction(d, sourceId, {
      candidates: [candidate({ term: 'Fresh', normalized: 'fresh' })],
      relations: [{ from: 'A', to: 'B', kind: 'requires', quote: 'q', page: 1 }],
      misconception_phrases: [{ quote: 'm', page: 1, section_path: [] }],
      equations: [{ latex: 'a = 1', variables: ['a'], page: 1, reading_order: 1, section_path: [], attached_term: null }],
    });

    const concepts = listConceptCandidatesBySource(d, sourceId);
    expect(concepts.map(c => c.term)).toEqual(['Fresh']);
    expect(listRelationCandidatesBySource(d, sourceId)).toHaveLength(1);
    expect(listMisconceptionCandidatesBySource(d, sourceId)).toHaveLength(1);
    expect(listEquationCandidatesBySource(d, sourceId)).toHaveLength(1);
    d.close();
  });
});
