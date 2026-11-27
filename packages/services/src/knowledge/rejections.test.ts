// Rejection memory (migration 0041) through the real re-extract entry points.
import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { DatabaseSync } from '../core/infra/sqlite';
import { segmentText } from '../ingestion/layout';
import { createSource } from './repos/sources';
import {
  createRelationCandidate, listConceptCandidatesBySource, listMisconceptionCandidatesBySource,
  listRelationCandidatesBySource, updateRelationCandidate,
} from './repos/candidates';
import {
  clearRejectionsForSource, listRejections, rejectConceptCandidate, rejectMisconceptionCandidate,
  rejectRelationCandidate, undoRejection,
} from './repos/rejections';
import { rejectCandidate, promoteCandidate } from './promotion';
import {
  computeDeterministicSuggestions, listPrerequisiteSuggestions, rejectPrerequisiteSuggestion,
} from './prerequisite_suggestions';
import { reextractCandidatesForSource, reprocessSourceDeterministic, type SegmentedSource } from './source_rebuild';

const TEXT = String.raw`# Optimization

## Gradient Descent

Gradient Descent is defined as an iterative optimization method that updates parameters opposite the gradient.
Gradient Descent requires a differentiable objective. The Learning Rate controls the step size.

\theta = \theta - \alpha \nabla L

A common misconception is that a larger learning rate always converges faster.

## Momentum

Momentum is defined as a method that accumulates an exponentially decaying average of past gradients.
Momentum enables faster convergence on ravines.
`;
const seg = (): SegmentedSource => ({ blocks: segmentText(TEXT), runningHeaderSections: [] });

const ENTRY_POINTS: Array<[string, (db: DatabaseSync, id: number) => void]> = [
  ['Re-extract button', (db, id) => { reprocessSourceDeterministic(db, id, seg(), 'Optimization'); }],
  ['candidate re-extract', (db, id) => { reextractCandidatesForSource(db, id, seg(), 'Optimization'); }],
];

function setup(db = openDb(':memory:'), name = 'opt.txt') {
  const sourceId = createSource(db, { filename: name, file_path: name, title: 'Optimization' }).id;
  reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');
  return { db, sourceId };
}
const terms = (db: DatabaseSync, s: number) => listConceptCandidatesBySource(db, s).map(c => c.term).sort();
const relations = (db: DatabaseSync, s: number) => listRelationCandidatesBySource(db, s).map(r => `${r.from}|${r.kind}|${r.to}`).sort();
const misconceptions = (db: DatabaseSync, s: number) => listMisconceptionCandidatesBySource(db, s).map(m => m.quote);
const conceptCand = (db: DatabaseSync, s: number, term: string) => listConceptCandidatesBySource(db, s).find(c => c.term === term)!;

describe.each(ENTRY_POINTS)('rejections persist through %s', (_name, reextract) => {
  it('a rejected concept candidate stays rejected across repeated re-extracts', () => {
    const { db, sourceId } = setup();
    rejectCandidate(db, conceptCand(db, sourceId, 'Momentum').id);
    reextract(db, sourceId);
    reextract(db, sourceId);
    expect(terms(db, sourceId)).not.toContain('Momentum');
    expect(terms(db, sourceId)).toContain('Gradient Descent');
    db.close();
  });

  it('a rejected parser relation and misconception stay rejected', () => {
    const { db, sourceId } = setup();
    const rel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'enables')!;
    expect(rejectRelationCandidate(db, rel.id)).toBe(true);
    const [mis] = listMisconceptionCandidatesBySource(db, sourceId);
    expect(rejectMisconceptionCandidate(db, mis.id)).toBe(true);
    reextract(db, sourceId);
    reextract(db, sourceId);
    expect(relations(db, sourceId).some(r => r.includes('|enables|'))).toBe(false);
    expect(misconceptions(db, sourceId)).toEqual([]);
    db.close();
  });

  it('rejecting an edited parser relation suppresses its parser original too', () => {
    const { db, sourceId } = setup();
    const rel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'requires')!;
    updateRelationCandidate(db, rel.id, { from: rel.from, to: 'a smooth loss', kind: 'requires' });
    rejectRelationCandidate(db, rel.id);
    reextract(db, sourceId);
    expect(relations(db, sourceId).some(r => r.includes('|requires|'))).toBe(false);
    db.close();
  });
});

describe('undo', () => {
  it('restores a rejected concept candidate immediately, and it then survives re-extract', () => {
    const { db, sourceId } = setup();
    rejectCandidate(db, conceptCand(db, sourceId, 'Momentum').id);
    const [rec] = listRejections(db, sourceId);
    expect(rec).toMatchObject({ kind: 'concept', label: 'Momentum' });

    expect(undoRejection(db, rec.id)).toBe(true);
    expect(terms(db, sourceId)).toContain('Momentum');
    expect(listRejections(db, sourceId)).toEqual([]);
    reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');
    expect(terms(db, sourceId).filter(t => t === 'Momentum')).toHaveLength(1);
    db.close();
  });

  it('restores an edited relation with its edit and ownership intact, without duplicating on re-extract', () => {
    const { db, sourceId } = setup();
    const rel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'requires')!;
    updateRelationCandidate(db, rel.id, { from: rel.from, to: 'a smooth loss', kind: 'requires' });
    rejectRelationCandidate(db, rel.id);
    undoRejection(db, listRejections(db, sourceId)[0].id);

    const row = db.prepare(`SELECT origin, user_modified_at, to_term FROM relation_candidates WHERE to_term = 'a smooth loss'`).get() as
      { origin: string; user_modified_at: string | null; to_term: string };
    expect(row.origin).toBe('parser');
    expect(row.user_modified_at).not.toBeNull();
    reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');
    expect(relations(db, sourceId).filter(r => r.includes('|requires|'))).toEqual([`${rel.from}|requires|a smooth loss`]);
    db.close();
  });

  it('clear restores every rejection for the source', () => {
    const { db, sourceId } = setup();
    const before = { t: terms(db, sourceId), r: relations(db, sourceId), m: misconceptions(db, sourceId) };
    rejectCandidate(db, conceptCand(db, sourceId, 'Momentum').id);
    rejectRelationCandidate(db, listRelationCandidatesBySource(db, sourceId)[0].id);
    rejectMisconceptionCandidate(db, listMisconceptionCandidatesBySource(db, sourceId)[0].id);
    expect(clearRejectionsForSource(db, sourceId)).toBe(3);
    expect({ t: terms(db, sourceId), r: relations(db, sourceId), m: misconceptions(db, sourceId) }).toEqual(before);
    db.close();
  });

  it('undoing a missing rejection is a no-op', () => {
    const { db } = setup();
    expect(undoRejection(db, 999)).toBe(false);
    db.close();
  });
});

describe('only parser identities are remembered', () => {
  it('deleting a user-created relation records no rejection', () => {
    const { db, sourceId } = setup();
    const mine = createRelationCandidate(db, sourceId, { from: 'X', to: 'Y', kind: 'causes', quote: '', page: 1 });
    expect(rejectRelationCandidate(db, mine.id)).toBe(false);
    expect(listRejections(db, sourceId)).toEqual([]);
    expect(relations(db, sourceId)).not.toContain('X|causes|Y');
    db.close();
  });

  it('deleting an unknown-origin legacy row records no rejection, so parser output is not matched to a guess', () => {
    const { db, sourceId } = setup();
    db.prepare('UPDATE relation_candidates SET origin = NULL, source_key = NULL WHERE source_id = ?').run(sourceId);
    const rel = listRelationCandidatesBySource(db, sourceId).find(r => r.kind === 'enables')!;
    expect(rejectRelationCandidate(db, rel.id)).toBe(false);
    expect(listRejections(db, sourceId)).toEqual([]);
    reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');
    // The parser re-emits it as a parser row (now rejectable with an identity).
    expect(relations(db, sourceId).some(r => r.includes('|enables|'))).toBe(true);
    db.close();
  });
});

describe('source isolation', () => {
  it('a rejection in one source does not suppress the same output in another', () => {
    const db = openDb(':memory:');
    const a = setup(db, 'a.txt').sourceId;
    const b = setup(db, 'b.txt').sourceId;
    rejectCandidate(db, conceptCand(db, a, 'Momentum').id);
    reprocessSourceDeterministic(db, a, seg(), 'Optimization');
    reprocessSourceDeterministic(db, b, seg(), 'Optimization');
    expect(terms(db, a)).not.toContain('Momentum');
    expect(terms(db, b)).toContain('Momentum');
    db.close();
  });
});

describe('prerequisite suggestions', () => {
  it('a rejected suggestion comes back dismissed after the re-extract wipe, and undo makes it pending', () => {
    const { db, sourceId } = setup();
    promoteCandidate(db, conceptCand(db, sourceId, 'Momentum').id);
    createRelationCandidate(db, sourceId, { from: 'Momentum', to: 'Gradient Descent', kind: 'requires', quote: '', page: 1 });
    promoteCandidate(db, conceptCand(db, sourceId, 'Gradient Descent').id);
    computeDeterministicSuggestions(db, sourceId);
    const [sug] = listPrerequisiteSuggestions(db, sourceId, 'pending');
    rejectPrerequisiteSuggestion(db, sug.id);

    reprocessSourceDeterministic(db, sourceId, seg(), 'Optimization');   // wipes suggestions
    computeDeterministicSuggestions(db, sourceId);
    expect(listPrerequisiteSuggestions(db, sourceId, 'pending')).toEqual([]);
    expect(listPrerequisiteSuggestions(db, sourceId, 'dismissed')).toHaveLength(1);

    const rec = listRejections(db, sourceId).find(r => r.kind === 'prerequisite')!;
    undoRejection(db, rec.id);
    expect(listPrerequisiteSuggestions(db, sourceId, 'pending')).toHaveLength(1);
    db.close();
  });
});

describe('a rejection is written in the same transaction as the delete', () => {
  it('if recording fails, the candidate is not deleted', () => {
    const { db, sourceId } = setup();
    db.exec(`CREATE TRIGGER fail_rej BEFORE INSERT ON candidate_rejections BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const id = conceptCand(db, sourceId, 'Momentum').id;
    expect(() => rejectConceptCandidate(db, id)).toThrow(/injected/);
    expect(terms(db, sourceId)).toContain('Momentum');
    db.close();
  });

  it('if the delete fails, no rejection is recorded', () => {
    const { db, sourceId } = setup();
    db.exec(`CREATE TRIGGER fail_del BEFORE DELETE ON relation_candidates BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const rel = listRelationCandidatesBySource(db, sourceId)[0];
    expect(() => rejectRelationCandidate(db, rel.id)).toThrow(/injected/);
    expect(listRejections(db, sourceId)).toEqual([]);
    db.close();
  });
});
