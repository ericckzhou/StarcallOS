// Re-extract must never delete user-owned data (audit H1). clearDerivedDataForSource
// may only drop concepts with origin 'llm' and nothing of the user's attached.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { DatabaseSync } from '../core/infra/sqlite';
import type { ConceptOrigin } from '../core/domain/types';
import { createSource } from './repos/sources';
import {
  addConceptEvidence, createConcept, createEdge, deleteConceptEvidenceByIndex, deleteConceptEvidenceSpan,
  getConceptById, renameConcept, updateCentralityScore, updateConceptEvidence, updateConceptFields,
} from './repos/concepts';
import {
  createConceptCandidate, createEquationCandidateForSource, createManualEquationForConcept, listConceptCandidatesBySource,
  listEquationCandidatesBySource, listEquationCandidatesForConcept, persistCandidateExtraction, updateEquationCandidate,
} from './repos/candidates';
import { createEvidenceRecord, createTask, recordSrsReview, setConceptSrsDue } from './repos/evidence';
import { createNote, listNotesByConcept } from './repos/concept_notes';
import { addMembers, createHub } from './repos/star_hubs';
import { createManualConcept, promoteCandidate } from './promotion';
import { clearDerivedDataForSource } from './cleanup';

function mk(db: DatabaseSync, sourceId: number, name: string, origin: ConceptOrigin | null) {
  return createConcept(db, {
    source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'), importance: 'supporting',
    definition_text: '', why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
    section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
  }, origin);
}

function setup() {
  const db = openDb(':memory:');
  const source = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
  return { db, sourceId: source.id };
}

function origin(db: DatabaseSync, id: number): string | null {
  return (db.prepare('SELECT origin FROM concepts WHERE id = ?').get(id) as { origin: string | null }).origin;
}

// One way per user-owned artifact to attach it to a concept.
const ARTIFACTS: Array<[string, (db: DatabaseSync, conceptId: number, sourceId: number) => void]> = [
  ['graded attempt', (db, id) => {
    const task = createTask(db, { concept_id: id, kind: 'definition', prompt: 'q', difficulty: 1 });
    createEvidenceRecord(db, {
      task_id: task.id, concept_id: id, user_response: 'a', score: 'gap', compression_stage: 1,
      gaps_detected: [], misconceptions_detected: [], grader_reasoning: 'r',
      task_prompt_snapshot: 'q', task_kind_snapshot: 'definition',
    });
  }],
  ['note', (db, id) => { createNote(db, id, { heading: 'mine', body: 'hours of work' }); }],
  ['tag', (db, id) => { db.prepare(`UPDATE concepts SET tags_json = '["exam"]' WHERE id = ?`).run(id); }],
  ['constellation link', (db, id) => {
    db.prepare(`UPDATE concepts SET where_reappears = '[{"name":"X","reason":"r"}]' WHERE id = ?`).run(id);
  }],
  ['hub membership', (db, id) => { const hub = createHub(db, { name: 'Hub' }); addMembers(db, hub.id, [id]); }],
  ['✓ Done review (SRS card)', (db, id) => { recordSrsReview(db, id, 'recognizes'); }],
  ['manual reschedule (SRS card)', (db, id) => { setConceptSrsDue(db, id, null); }],
  ['prerequisite edge', (db, id, sourceId) => {
    const other = mk(db, sourceId, 'Other Concept', 'promoted');
    createEdge(db, other.id, id, 'requires');
  }],
  ['ask history', (db, id) => {
    db.prepare(`INSERT INTO ask_history (concept_id, question, status, result_json) VALUES (?, 'q', 'grounded', '{}')`).run(id);
  }],
  ['PDF annotation', (db, id, sourceId) => {
    db.prepare(`INSERT INTO pdf_annotations (source_id, concept_id, type, created_from, page, color, rects_json)
                VALUES (?, ?, 'highlight', 'selection', 1, '#ff0', '[]')`).run(sourceId, id);
  }],
  ['soft-deleted PDF annotation (undo pending)', (db, id, sourceId) => {
    db.prepare(`INSERT INTO pdf_annotations (source_id, concept_id, type, created_from, page, color, rects_json, deleted_at)
                VALUES (?, ?, 'sticky', 'manual', 1, '#ff0', '[]', datetime('now'))`).run(sourceId, id);
  }],
];

describe('clearDerivedDataForSource: user-owned data survives re-extract', () => {
  it('deletes an LLM concept that carries no user data', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Disposable', 'llm');
    const counts = clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).toBeNull();
    expect(counts).toMatchObject({ concepts_deleted: 1, concepts_preserved: 0 });
    db.close();
  });

  it.each(ARTIFACTS)('keeps an LLM concept that has a %s', (_label, attach) => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Used LLM Concept', 'llm');
    attach(db, c.id, sourceId);
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });

  it('keeps a manual concept with nothing attached', () => {
    const { db, sourceId } = setup();
    const c = createManualConcept(db, { sourceId, name: 'My manual concept' });
    expect(origin(db, c.id)).toBe('manual');
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });

  // The audit repro: manual concept + note + hub + ✓ Done, then Re-extract.
  it('keeps a manual concept together with its note, hub membership and SRS card', () => {
    const { db, sourceId } = setup();
    const c = createManualConcept(db, { sourceId, name: 'My manual concept', definition_text: 'user-written' });
    createNote(db, c.id, { heading: 'My note', body: 'hours of work' });
    const hub = createHub(db, { name: 'Hub' });
    addMembers(db, hub.id, [c.id]);
    recordSrsReview(db, c.id, 'recognizes');

    const counts = clearDerivedDataForSource(db, sourceId);

    expect(counts.concepts_deleted).toBe(0);
    expect(getConceptById(db, c.id)?.definition_text).toBe('user-written');
    expect(listNotesByConcept(db, c.id).map(n => n.heading)).toEqual(['My note']);
    const n = (sql: string) => (db.prepare(sql).get(c.id) as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM star_hub_members WHERE concept_id = ?')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM concept_srs WHERE concept_id = ?')).toBe(1);
    db.close();
  });

  it('keeps unknown-origin (pre-0038) concepts even with nothing attached', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Legacy Concept', null);
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });

  it('preserveUserData: false is still an explicit full wipe', () => {
    const { db, sourceId } = setup();
    const c = createManualConcept(db, { sourceId, name: 'Manual' });
    clearDerivedDataForSource(db, sourceId, { preserveUserData: false });
    expect(getConceptById(db, c.id)).toBeNull();
    db.close();
  });

  it('only touches the given source', () => {
    const { db, sourceId } = setup();
    const other = createSource(db, { filename: 'b.pdf', file_path: 'b.pdf' });
    const keep = mk(db, other.id, 'Other Source LLM', 'llm');
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, keep.id)).not.toBeNull();
    db.close();
  });
});

describe('a user edit makes generated content non-disposable', () => {
  function userModifiedAt(db: DatabaseSync, id: number): string | null {
    return (db.prepare('SELECT user_modified_at AS m FROM concepts WHERE id = ?').get(id) as { m: string | null }).m;
  }

  it('keeps an LLM concept whose only change is a user-edited definition, with the edit intact', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Generated Concept', 'llm');
    updateConceptFields(db, c.id, { definition_text: 'My own definition, written by hand.' });

    clearDerivedDataForSource(db, sourceId);

    expect(getConceptById(db, c.id)?.definition_text).toBe('My own definition, written by hand.');
    db.close();
  });

  const EDITS: Array<[string, (db: DatabaseSync, id: number) => void]> = [
    ['rename', (db, id) => { renameConcept(db, id, 'Renamed By User'); }],
    ['importance change', (db, id) => { updateConceptFields(db, id, { importance: 'core' }); }],
    ['evidence span added', (db, id) => {
      addConceptEvidence(db, id, { page: 2, kind: 'definition', label: 'mine', quote: 'a quote the user picked' });
    }],
    ['evidence span edited', (db, id) => {
      addConceptEvidence(db, id, { page: 2, kind: 'definition', label: 'mine', quote: 'q' });
      db.prepare('UPDATE concepts SET user_modified_at = NULL WHERE id = ?').run(id);
      updateConceptEvidence(db, id, 0, { label: 'edited' });
    }],
    ['evidence span removed by index', (db, id) => {
      addConceptEvidence(db, id, { page: 2, kind: 'definition', label: 'mine', quote: 'q' });
      db.prepare('UPDATE concepts SET user_modified_at = NULL WHERE id = ?').run(id);
      deleteConceptEvidenceByIndex(db, id, 0);
    }],
    ['evidence span removed by match', (db, id) => {
      addConceptEvidence(db, id, { page: 2, kind: 'definition', label: 'mine', quote: 'q' });
      db.prepare('UPDATE concepts SET user_modified_at = NULL WHERE id = ?').run(id);
      deleteConceptEvidenceSpan(db, id, 2, 'definition', 'q');
    }],
  ];

  it.each(EDITS)('a %s stamps user_modified_at and keeps the concept', (_label, edit) => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Generated Concept', 'llm');
    edit(db, c.id);
    expect(userModifiedAt(db, c.id)).not.toBeNull();
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });

  it('system writes (centrality scoring) do not count as a user edit', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Generated Concept', 'llm');
    updateCentralityScore(db, c.id, 0.5);
    expect(userModifiedAt(db, c.id)).toBeNull();
    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, c.id)).toBeNull();
    db.close();
  });
});

describe('re-extract keeps user-owned equations and does not duplicate them', () => {
  type Eq = Parameters<typeof persistCandidateExtraction>[2]['equations'] extends (infer A)[] | undefined ? A : never;
  const parserEq = (latex: string, page = 3, reading_order = 10): Eq =>
    ({ latex, variables: [], page, reading_order, section_path: [], attached_term: null }) as Eq;
  const reextract = (db: DatabaseSync, sourceId: number, equations: Eq[]) =>
    persistCandidateExtraction(db, sourceId, { candidates: [], relations: [], misconception_phrases: [], equations });
  const latexes = (db: DatabaseSync, sourceId: number) => listEquationCandidatesBySource(db, sourceId).map(e => e.latex).sort();

  it('replaces unedited parser equations (still regenerable) without duplicating them', () => {
    const { db, sourceId } = setup();
    reextract(db, sourceId, [parserEq('E = mc^2')]);
    reextract(db, sourceId, [parserEq('E = mc^2')]);
    reextract(db, sourceId, [parserEq('F = ma')]);
    expect(latexes(db, sourceId)).toEqual(['F = ma']);
    db.close();
  });

  it('keeps a user equation added from a concept Overview, attached to the concept', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Gradient Descent', 'promoted');
    createManualEquationForConcept(db, { conceptId: c.id, latex: '\\theta \\leftarrow \\theta - \\eta \\nabla L' });
    reextract(db, sourceId, [parserEq('E = mc^2')]);
    clearDerivedDataForSource(db, sourceId);
    expect(listEquationCandidatesForConcept(db, c.id).map(e => e.latex)).toEqual(['\\theta \\leftarrow \\theta - \\eta \\nabla L']);
    db.close();
  });

  it('keeps a user equation added from Candidate Review, through both wipe paths', () => {
    const { db, sourceId } = setup();
    createEquationCandidateForSource(db, { sourceId, latex: 'a^2 + b^2 = c^2', page: 4 });
    clearDerivedDataForSource(db, sourceId);
    reextract(db, sourceId, []);
    expect(latexes(db, sourceId)).toEqual(['a^2 + b^2 = c^2']);
    db.close();
  });

  it('keeps a user-edited parser equation and does not re-add the parser original beside it', () => {
    const { db, sourceId } = setup();
    reextract(db, sourceId, [parserEq('E = m c^{2}')]);
    const [eq] = listEquationCandidatesBySource(db, sourceId);
    updateEquationCandidate(db, eq.id, { latex: 'E = mc^2  % corrected by me' });

    reextract(db, sourceId, [parserEq('E = m c^{2}')]);
    reextract(db, sourceId, [parserEq('E = m c^{2}')]);
    clearDerivedDataForSource(db, sourceId);

    expect(latexes(db, sourceId)).toEqual(['E = mc^2  % corrected by me']);
    db.close();
  });

  it('keeps unknown-origin (pre-0039) equations and does not duplicate them on re-extract', () => {
    const { db, sourceId } = setup();
    reextract(db, sourceId, [parserEq('x = y')]);
    db.prepare('UPDATE equation_candidates SET origin = NULL WHERE source_id = ?').run(sourceId);

    reextract(db, sourceId, [parserEq('x = y'), parserEq('z = w')]);
    clearDerivedDataForSource(db, sourceId);
    reextract(db, sourceId, [parserEq('x = y'), parserEq('z = w')]);

    expect(latexes(db, sourceId)).toEqual(['x = y', 'z = w']);
    db.close();
  });

  it('matches on page and ignores whitespace when deduplicating', () => {
    const { db, sourceId } = setup();
    createEquationCandidateForSource(db, { sourceId, latex: 'a + b', page: 3 });
    reextract(db, sourceId, [parserEq('a+b', 3), parserEq('a + b', 9)]);
    const rows = listEquationCandidatesBySource(db, sourceId).map(e => `${e.page}:${e.latex}`).sort();
    expect(rows).toEqual(['3:a + b', '9:a + b']);
    db.close();
  });

  it('editing an equation from the concept Overview keeps it attached to the concept', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Gradient Descent', 'promoted');
    const eq = createManualEquationForConcept(db, { conceptId: c.id, latex: 'x' });
    // Same call shape as the concepts:equationUpdate IPC handler (no attached_term).
    updateEquationCandidate(db, eq.id, { latex: 'x + 1', page: 2 });
    expect(listEquationCandidatesForConcept(db, c.id).map(e => e.latex)).toEqual(['x + 1']);
    db.close();
  });

  it('migration 0039 backfill leaves legacy rows unknown-origin with source_latex = latex', () => {
    const { db, sourceId } = setup();
    db.prepare(`INSERT INTO equation_candidates (source_id, latex, page) VALUES (?, 'legacy', 1)`).run(sourceId);
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0039_equation_origin.sql'), 'utf-8');
    db.exec(sql.slice(sql.indexOf('UPDATE equation_candidates')));
    expect(db.prepare(`SELECT origin, source_latex FROM equation_candidates WHERE latex = 'legacy'`).get())
      .toEqual({ origin: null, source_latex: 'legacy' });
    db.close();
  });
});

describe('promoting a candidate onto an existing LLM concept', () => {
  it('makes the concept promoted (user-owned), snapshots evidence, and it survives re-extract without duplicates', () => {
    const { db, sourceId } = setup();
    const llm = mk(db, sourceId, 'Gradient Descent', 'llm');
    createConceptCandidate(db, sourceId, {
      term: 'Gradient Descent', normalized: 'gradient descent', confidence: 0.9, mention_count: 2, first_page: 3,
      section_path: [], evidence: [{ source: 'definition_pattern', quote: 'Gradient Descent is an iterative method.', page: 3 }],
      suggested_importance: 'core',
    } as unknown as Parameters<typeof createConceptCandidate>[2]);
    const [cand] = listConceptCandidatesBySource(db, sourceId);

    const promoted = promoteCandidate(db, cand.id);

    expect(promoted.id).toBe(llm.id);
    expect(origin(db, llm.id)).toBe('promoted');
    const ev = (db.prepare('SELECT evidence_json AS e FROM concepts WHERE id = ?').get(llm.id) as { e: string }).e;
    expect(JSON.parse(ev)).toHaveLength(1);
    expect(listConceptCandidatesBySource(db, sourceId)).toEqual([]);

    clearDerivedDataForSource(db, sourceId);
    expect(getConceptById(db, llm.id)).not.toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM concepts WHERE source_id = ?').get(sourceId) as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('migration 0038 backfill is conservative', () => {
  it('labels only evidence-snapshot concepts as promoted and leaves the rest unknown', () => {
    const { db, sourceId } = setup();
    const promoted = mk(db, sourceId, 'Promoted Before 0038', null);
    const manualish = mk(db, sourceId, 'Manual Before 0038', null);
    db.prepare(`UPDATE concepts SET evidence_json = '[{"source":"definition_pattern","page":1}]' WHERE id = ?`).run(promoted.id);

    // Re-run the migration's backfill statement against pre-0038-shaped rows.
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0038_concept_origin.sql'), 'utf-8');
    db.exec(sql.slice(sql.indexOf('UPDATE concepts')));

    expect(origin(db, promoted.id)).toBe('promoted');
    expect(origin(db, manualish.id)).toBeNull();
    // Nothing is ever backfilled as disposable.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE origin = 'llm'`).get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('clearDerivedDataForSource is atomic', () => {
  function seedCandidate(db: DatabaseSync, sourceId: number) {
    createConceptCandidate(db, sourceId, {
      term: 'Gradient Descent', normalized: 'gradient descent', confidence: 0.9, mention_count: 2,
      first_page: 1, section_path: [], evidence: [], suggested_importance: 'core',
    } as unknown as Parameters<typeof createConceptCandidate>[2]);
  }

  it('rolls back every delete when one fails part-way', () => {
    const { db, sourceId } = setup();
    seedCandidate(db, sourceId);
    mk(db, sourceId, 'Disposable', 'llm');
    db.exec(`CREATE TRIGGER fail_concept_delete BEFORE DELETE ON concepts BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    expect(() => clearDerivedDataForSource(db, sourceId)).toThrow(/boom/);
    // Candidates were deleted before the failure; the savepoint restored them.
    expect(listConceptCandidatesBySource(db, sourceId)).toHaveLength(1);
    db.close();
  });

  it('nests inside a caller transaction', () => {
    const { db, sourceId } = setup();
    const c = mk(db, sourceId, 'Disposable', 'llm');
    db.exec('BEGIN');
    clearDerivedDataForSource(db, sourceId);
    db.exec('ROLLBACK');
    expect(getConceptById(db, c.id)).not.toBeNull();
    db.close();
  });
});
