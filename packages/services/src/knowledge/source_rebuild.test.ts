// Integration tests for the real re-extract entry points. Main calls exactly
// these two functions (sources.process -> reprocessSourceDeterministic;
// candidates:extract / bulk re-extract -> reextractCandidatesForSource) with
// segmented blocks; here the blocks come from the real text segmenter, and
// every user action goes through the same repo functions the IPC handlers use.
import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { DatabaseSync } from '../core/infra/sqlite';
import { segmentText } from '../ingestion/layout';
import { createSource } from './repos/sources';
import { createConcept, getConceptById, listConceptsBySource, renameConcept, updateConceptFields, addConceptEvidence, createEdge } from './repos/concepts';
import {
  createEquationCandidateForSource, createManualEquationForConcept, createMisconceptionCandidate, createRelationCandidate,
  listConceptCandidatesBySource, listEquationCandidatesBySource, listMisconceptionCandidatesBySource,
  listRelationCandidatesBySource, updateEquationCandidate, updateMisconceptionCandidate, updateRelationCandidate,
} from './repos/candidates';
import { createNote, listNotesByConcept } from './repos/concept_notes';
import { createManualConcept, promoteCandidate } from './promotion';
import { reextractCandidatesForSource, reprocessSourceDeterministic, type SegmentedSource } from './source_rebuild';

const TEXT = String.raw`# Optimization

## Gradient Descent

Gradient Descent is defined as an iterative optimization method that updates parameters opposite the gradient.
Gradient Descent requires a differentiable objective. The Learning Rate controls the step size.
The update rule is applied at every step.

\theta = \theta - \alpha \nabla L

A common misconception is that a larger learning rate always converges faster.

## Momentum

Momentum is defined as a method that accumulates an exponentially decaying average of past gradients.
Momentum enables faster convergence on ravines.
`;

const seg = (): SegmentedSource => ({ blocks: segmentText(TEXT), runningHeaderSections: [] });

// The two real entry points, by the name of the UI action that reaches them.
const ENTRY_POINTS: Array<[string, (db: DatabaseSync, sourceId: number) => void]> = [
  ['Re-extract button (sources.process)', (db, id) => { reprocessSourceDeterministic(db, id, seg(), 'Optimization'); }],
  ['candidate re-extract (candidates:extract / bulk)', (db, id) => { reextractCandidatesForSource(db, id, seg(), 'Optimization'); }],
];

function setup() {
  const db = openDb(':memory:');
  const sourceId = createSource(db, { filename: 'opt.txt', file_path: 'opt.txt', title: 'Optimization' }).id;
  reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');   // first processing
  return { db, sourceId };
}

function snapshot(db: DatabaseSync, sourceId: number) {
  return {
    concepts: listConceptsBySource(db, sourceId).map(c => c.name).sort(),
    conceptCandidates: listConceptCandidatesBySource(db, sourceId).map(c => c.term).sort(),
    relations: listRelationCandidatesBySource(db, sourceId).map(r => `${r.from}|${r.kind}|${r.to}`).sort(),
    equations: listEquationCandidatesBySource(db, sourceId).map(e => e.latex).sort(),
    misconceptions: listMisconceptionCandidatesBySource(db, sourceId).map(m => m.quote).sort(),
  };
}

const candidateId = (db: DatabaseSync, sourceId: number, term: string) =>
  listConceptCandidatesBySource(db, sourceId).find(c => c.term === term)!.id;

describe('the fixture exercises every candidate kind', () => {
  it('produces concept, relation, equation and misconception candidates', () => {
    const { db, sourceId } = setup();
    const s = snapshot(db, sourceId);
    expect(s.conceptCandidates).toContain('Gradient Descent');
    expect(s.relations.length).toBeGreaterThanOrEqual(2);
    expect(s.equations).toHaveLength(1);
    expect(s.misconceptions).toHaveLength(1);
    db.close();
  });
});

describe.each(ENTRY_POINTS)('%s', (_name, reextract) => {
  it('is idempotent: re-extracting twice creates no duplicate concepts or candidates', () => {
    const { db, sourceId } = setup();
    const first = snapshot(db, sourceId);
    reextract(db, sourceId);
    reextract(db, sourceId);
    expect(snapshot(db, sourceId)).toEqual(first);
    db.close();
  });

  it('keeps a promoted concept, and re-promoting it is idempotent and overwrites nothing the user wrote', () => {
    const { db, sourceId } = setup();
    const c = promoteCandidate(db, candidateId(db, sourceId, 'Gradient Descent'));
    updateConceptFields(db, c.id, { definition_text: 'My own definition.' });
    createNote(db, c.id, { heading: 'mine', body: '' });
    const evidenceBefore = (db.prepare('SELECT evidence_json AS e FROM concepts WHERE id = ?').get(c.id) as { e: string }).e;

    reextract(db, sourceId);
    reextract(db, sourceId);
    // The candidate is regenerated; promoting it again must hit the same row.
    const again = listConceptCandidatesBySource(db, sourceId).find(x => x.term === 'Gradient Descent');
    if (again) expect(promoteCandidate(db, again.id).id).toBe(c.id);

    const after = getConceptById(db, c.id)!;
    expect(after.definition_text).toBe('My own definition.');
    expect(listNotesByConcept(db, c.id).map(n => n.heading)).toEqual(['mine']);
    expect((db.prepare('SELECT evidence_json AS e FROM concepts WHERE id = ?').get(c.id) as { e: string }).e).toBe(evidenceBefore);
    expect(listConceptsBySource(db, sourceId).filter(x => x.name === 'Gradient Descent')).toHaveLength(1);
    db.close();
  });

  it('keeps a manual concept and its note', () => {
    const { db, sourceId } = setup();
    const c = createManualConcept(db, { sourceId, name: 'Adam Optimizer', definition_text: 'hand written' });
    createNote(db, c.id, { heading: 'note', body: '' });
    reextract(db, sourceId);
    expect(getConceptById(db, c.id)?.definition_text).toBe('hand written');
    expect(listNotesByConcept(db, c.id)).toHaveLength(1);
    db.close();
  });

  it('keeps every user-edited candidate kind with the edit intact and without re-adding the parser original', () => {
    const { db, sourceId } = setup();
    const rel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'requires')!;
    updateRelationCandidate(db, rel.id, { from: 'Gradient Descent', to: 'a smooth loss', kind: 'requires' });
    const [mis] = listMisconceptionCandidatesBySource(db, sourceId);
    updateMisconceptionCandidate(db, mis.id, { quote: 'Bigger steps always converge faster (my wording).', page: mis.page });
    const [eq] = listEquationCandidatesBySource(db, sourceId);
    updateEquationCandidate(db, eq.id, { latex: String.raw`\theta \leftarrow \theta - \alpha \nabla L` });
    const counts = (s: ReturnType<typeof snapshot>) => [s.relations.length, s.misconceptions.length, s.equations.length];
    const before = snapshot(db, sourceId);

    reextract(db, sourceId);
    reextract(db, sourceId);

    const after = snapshot(db, sourceId);
    expect(after.relations).toContain('Gradient Descent|requires|a smooth loss');
    expect(after.relations.some(r => r.endsWith('a differentiable objective'))).toBe(false);
    expect(after.misconceptions).toEqual(['Bigger steps always converge faster (my wording).']);
    expect(after.equations).toEqual([String.raw`\theta \leftarrow \theta - \alpha \nabla L`]);
    expect(counts(after)).toEqual(counts(before));
    db.close();
  });

  it('keeps user-created candidates, and one identical to parser output is not duplicated', () => {
    const { db, sourceId } = setup();
    createRelationCandidate(db, sourceId, { from: 'Momentum', to: 'Gradient Descent', kind: 'example_of', quote: '', page: 1 });
    createMisconceptionCandidate(db, sourceId, { quote: 'Momentum never overshoots.', page: 1, section_path: [] });
    createEquationCandidateForSource(db, { sourceId, latex: 'v = \\beta v + g', page: 1 });
    // A user row that matches what the parser emits (same relation, same page).
    const parserRel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'enables')!;
    createRelationCandidate(db, sourceId, { from: parserRel.from, to: parserRel.to, kind: 'enables', quote: 'mine', page: parserRel.page });
    const before = snapshot(db, sourceId);

    reextract(db, sourceId);
    reextract(db, sourceId);

    const after = snapshot(db, sourceId);
    expect(after.relations).toContain('Momentum|example_of|Gradient Descent');
    expect(after.misconceptions).toContain('Momentum never overshoots.');
    expect(after.equations).toContain('v = \\beta v + g');
    // The user's copy of the parser relation replaced the parser row, not joined it.
    expect(after.relations.filter(r => r === `${parserRel.from}|enables|${parserRel.to}`)).toHaveLength(1);
    expect(after.relations.length).toBe(before.relations.length - 1);
    db.close();
  });

  it('keeps unknown-origin (legacy) candidates without duplicating them', () => {
    const { db, sourceId } = setup();
    for (const t of ['relation_candidates', 'misconception_candidates', 'equation_candidates']) {
      db.prepare(`UPDATE ${t} SET origin = NULL, source_key = NULL WHERE source_id = ?`.replace(', source_key = NULL', t === 'equation_candidates' ? '' : ', source_key = NULL')).run(sourceId);
    }
    const before = snapshot(db, sourceId);
    reextract(db, sourceId);
    reextract(db, sourceId);
    expect(snapshot(db, sourceId)).toEqual(before);
    db.close();
  });

  it('keeps an LLM concept the user renamed, or whose definition the user edited', () => {
    const { db, sourceId } = setup();
    const mk = (name: string) => createConcept(db, {
      source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'), importance: 'supporting',
      definition_text: 'generated', why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
      section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
    }, 'llm');
    const renamed = mk('Generated A');
    const edited = mk('Generated B');
    const untouched = mk('Generated C');
    renameConcept(db, renamed.id, 'Renamed By Me');
    updateConceptFields(db, edited.id, { definition_text: 'edited by me' });

    // Only the Re-extract button wipes concepts; candidate re-extract never does.
    reextract(db, sourceId);

    expect(getConceptById(db, renamed.id)?.name).toBe('Renamed By Me');
    expect(getConceptById(db, edited.id)?.definition_text).toBe('edited by me');
    if (_name.startsWith('Re-extract button')) expect(getConceptById(db, untouched.id)).toBeNull();
    else expect(getConceptById(db, untouched.id)).not.toBeNull();
    db.close();
  });

  it('keeps a promoted-onto-LLM concept with its notes, evidence and relationships', () => {
    const { db, sourceId } = setup();
    const llm = createConcept(db, {
      source_id: sourceId, name: 'Gradient Descent', slug: 'gradient-descent', importance: 'core',
      definition_text: 'generated', why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
      section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
    }, 'llm');
    createNote(db, llm.id, { heading: 'my note', body: '' });
    addConceptEvidence(db, llm.id, { page: 1, kind: 'definition', label: 'mine', quote: 'a span I picked' });
    db.prepare('UPDATE concepts SET user_modified_at = NULL WHERE id = ?').run(llm.id); // isolate promotion
    const other = createManualConcept(db, { sourceId, name: 'Calculus' });
    createEdge(db, other.id, llm.id, 'requires');
    const evidenceBefore = (db.prepare('SELECT evidence_json AS e FROM concepts WHERE id = ?').get(llm.id) as { e: string }).e;

    const p1 = promoteCandidate(db, candidateId(db, sourceId, 'Gradient Descent'));
    reextract(db, sourceId);
    const again = listConceptCandidatesBySource(db, sourceId).find(x => x.term === 'Gradient Descent');
    if (again) promoteCandidate(db, again.id);   // promote twice
    reextract(db, sourceId);

    const row = db.prepare('SELECT origin, user_modified_at, evidence_json, definition_text FROM concepts WHERE id = ?').get(llm.id) as
      { origin: string; user_modified_at: string | null; evidence_json: string; definition_text: string };
    expect(p1.id).toBe(llm.id);
    expect(row.origin).toBe('promoted');
    // Promotion is an ownership event, not an edit: it does not stamp user_modified_at.
    expect(row.user_modified_at).toBeNull();
    // The user's existing evidence is not overwritten by the candidate's.
    expect(row.evidence_json).toBe(evidenceBefore);
    expect(row.definition_text).toBe('generated');
    expect(listNotesByConcept(db, llm.id).map(n => n.heading)).toEqual(['my note']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM concept_edges WHERE to_id = ?').get(llm.id) as { n: number }).n).toBe(1);
    expect(listConceptsBySource(db, sourceId).filter(x => x.name === 'Gradient Descent')).toHaveLength(1);
    db.close();
  });

  it('keeps a user equation added from a concept Overview', () => {
    const { db, sourceId } = setup();
    const c = promoteCandidate(db, candidateId(db, sourceId, 'Gradient Descent'));
    createManualEquationForConcept(db, { conceptId: c.id, latex: 'g = \\nabla L' });
    reextract(db, sourceId);
    reextract(db, sourceId);
    expect(snapshot(db, sourceId).equations).toContain('g = \\nabla L');
    db.close();
  });
});

describe('a failure mid-rebuild leaves the previous state intact', () => {
  function failOnInsert(db: DatabaseSync) {
    db.exec(`CREATE TRIGGER fail_mis BEFORE INSERT ON misconception_candidates BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  }

  it('Re-extract button: reports the error, keeps the previous candidate set and all concepts', () => {
    const { db, sourceId } = setup();
    const c = promoteCandidate(db, candidateId(db, sourceId, 'Gradient Descent'));
    const before = snapshot(db, sourceId);
    failOnInsert(db);

    const r = reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');

    expect(r.candidateError).toMatch(/injected/);
    expect(snapshot(db, sourceId)).toEqual(before);
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });

  it('candidate re-extract: throws and keeps the previous candidate set', () => {
    const { db, sourceId } = setup();
    const before = snapshot(db, sourceId);
    failOnInsert(db);
    expect(() => reextractCandidatesForSource(db, sourceId, seg(), 'Optimization')).toThrow(/injected/);
    expect(snapshot(db, sourceId)).toEqual(before);
    db.close();
  });
});
