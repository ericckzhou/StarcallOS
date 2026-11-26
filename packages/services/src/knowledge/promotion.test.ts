import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import { queryEvents } from '../core/events';
import type { ConceptCandidate } from '../ingestion/candidates';
import { createConceptCandidate, getConceptCandidateById, listConceptCandidatesBySource } from './repos/candidates';
import { createSource, getSourceById, updateSourceStatus } from './repos/sources';
import { createConcept, getConceptById, listConceptsBySource } from './repos/concepts';
import { createEvidenceRecord, createTask, getMastery } from './repos/evidence';
import { createManualConcept, promoteCandidate, rejectCandidate, rejectCandidatesBulk } from './promotion';
import { recoverInterruptedSources, sourceHasStudyHistory } from './cleanup';

type Db = ReturnType<typeof openDb>;

function setup(): { db: Db; sourceId: number } {
  const db = openDb(':memory:');
  const source = createSource(db, { filename: 'notes.txt', file_path: 'notes.txt', title: 'Notes' });
  return { db, sourceId: source.id };
}

// Insert one candidate and return its id.
function addCandidate(
  db: Db,
  sourceId: number,
  term: string,
  opts: { confidence?: number; evidence?: ConceptCandidate['evidence'] } = {},
): number {
  createConceptCandidate(db, sourceId, {
    term,
    normalized: term.toLowerCase(),
    confidence: opts.confidence ?? 0.7,
    evidence: opts.evidence ?? [{ source: 'heading', quote: term, page: 1 }],
    section_path: ['Intro'],
    first_page: 1,
    mention_count: 1,
    topic_relevance_score: 0.5,
    topic_relevance_reasons: [],
    is_boilerplate: false,
    is_broad: false,
    concept_score: 0,
    reject_reasons: [],
  });
  return listConceptCandidatesBySource(db, sourceId).find(c => c.term === term)!.id;
}

function plainConcept(db: Db, sourceId: number, name: string, slug: string) {
  return createConcept(db, {
    source_id: sourceId, name, slug, importance: 'supporting',
    definition_text: '', why_exists: '', what_breaks: '', where_reappears: [],
    chunk_ids: [], section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
  });
}

describe('promoteCandidate', () => {
  it('throws on an unknown candidate', () => {
    const { db } = setup();
    expect(() => promoteCandidate(db, 999)).toThrow(/candidate 999 not found/);
    db.close();
  });

  it('is idempotent on (source_id, slug): returns the existing concept and drops the candidate', () => {
    const { db, sourceId } = setup();
    const first = promoteCandidate(db, addCandidate(db, sourceId, 'Gradient Descent'));
    // Same slug from a differently-cased/punctuated term.
    const dupId = addCandidate(db, sourceId, 'gradient descent!');
    const second = promoteCandidate(db, dupId);
    expect(second.id).toBe(first.id);
    expect(getConceptCandidateById(db, dupId)).toBeNull();
    expect(listConceptsBySource(db, sourceId)).toHaveLength(1);
    db.close();
  });

  it('does not create a duplicate when the slug already exists from another path', () => {
    const { db, sourceId } = setup();
    const llm = plainConcept(db, sourceId, 'Backprop', 'backprop');
    const promoted = promoteCandidate(db, addCandidate(db, sourceId, 'Backprop'));
    expect(promoted.id).toBe(llm.id);
    db.close();
  });

  it('seeds the definition from a definition_pattern quote over earlier prose', () => {
    const { db, sourceId } = setup();
    const id = addCandidate(db, sourceId, 'Entropy', {
      evidence: [
        { source: 'heading', quote: 'Entropy', page: 2 },
        { source: 'repetition', quote: 'appears 12x across the whole document', page: 2 },
        { source: 'bold_block', quote: 'Entropy shows up again in chapter four of the text.', page: 3 },
        { source: 'definition_pattern', quote: 'Entropy is defined as the expected surprisal of a distribution.', page: 4, pattern: 'is_defined_as' },
      ],
    });
    const c = promoteCandidate(db, id);
    expect(c.definition_text).toBe('Entropy is defined as the expected surprisal of a distribution.');
    db.close();
  });

  it('falls back to the first real prose quote, skipping synthetic and tautological ones', () => {
    const { db, sourceId } = setup();
    const id = addCandidate(db, sourceId, 'Entropy', {
      evidence: [
        { source: 'heading', quote: '# Entropy', page: 2 },
        { source: 'capitalized_phrase', quote: 'Entropy appears 9 times in this source', page: 2 },
        { source: 'bold_block', quote: 'Entropy measures uncertainty in a random variable.', page: 3 },
      ],
    });
    expect(promoteCandidate(db, id).definition_text).toBe('Entropy measures uncertainty in a random variable.');
    db.close();
  });

  it('leaves the definition empty when no real prose survives', () => {
    const { db, sourceId } = setup();
    const id = addCandidate(db, sourceId, 'Entropy', {
      evidence: [
        { source: 'heading', quote: 'Entropy', page: 2 },
        { source: 'repetition', quote: 'appears 40x in the document body', page: 2 },
      ],
    });
    expect(promoteCandidate(db, id).definition_text).toBe('');
    db.close();
  });

  it('maps confidence to importance and exam value at the thresholds', () => {
    const { db, sourceId } = setup();
    const cases: Array<[string, number, string]> = [
      ['Core Term', 0.9, 'core'],
      ['Supporting Term', 0.55, 'supporting'],
      ['Peripheral Term', 0.54, 'peripheral'],
    ];
    for (const [term, confidence, importance] of cases) {
      const c = promoteCandidate(db, addCandidate(db, sourceId, term, { confidence }));
      expect(c.importance).toBe(importance);
      expect(c.exam_value).toBe(Math.round(confidence * 100));
    }
    db.close();
  });

  it('snapshots evidence, seeds Unseen mastery, emits an event, and consumes the candidate', () => {
    const { db, sourceId } = setup();
    const evidence = [{ source: 'heading' as const, quote: 'Attention', page: 7 }];
    const id = addCandidate(db, sourceId, 'Attention', { evidence, confidence: 0.8 });
    const c = promoteCandidate(db, id);

    const row = db.prepare('SELECT evidence_json FROM concepts WHERE id = ?').get(c.id) as { evidence_json: string };
    expect(JSON.parse(row.evidence_json)).toEqual(evidence);
    expect(getMastery(db, c.id)?.compression_stage).toBe(0);
    expect(getConceptCandidateById(db, id)).toBeNull();
    expect(c.section_path).toEqual(['Intro']);

    const ev = queryEvents(db).find(e => e.type === 'concept.promoted_from_candidate');
    expect(ev?.payload).toMatchObject({ conceptId: c.id, candidateId: id, confidence: 0.8 });
    db.close();
  });

  it('falls back to a candidate-id slug when the term has no slug characters', () => {
    const { db, sourceId } = setup();
    const id = addCandidate(db, sourceId, 'Σ∂');
    expect(promoteCandidate(db, id).slug).toBe(`candidate-${id}`);
    db.close();
  });
});

describe('createManualConcept', () => {
  it('rejects a blank name', () => {
    const { db, sourceId } = setup();
    expect(() => createManualConcept(db, { sourceId, name: '   ' })).toThrow(/cannot be empty/);
    db.close();
  });

  it('trims fields, defaults importance, seeds mastery, and is idempotent by slug', () => {
    const { db, sourceId } = setup();
    const c = createManualConcept(db, {
      sourceId, name: '  Learning Rate  ', definition_text: ' step size ', why_exists: ' ', what_breaks: ' divergence ',
    });
    expect(c.name).toBe('Learning Rate');
    expect(c.slug).toBe('learning-rate');
    expect(c.importance).toBe('supporting');
    expect(c.definition_text).toBe('step size');
    expect(c.why_exists).toBe('');
    expect(c.what_breaks).toBe('divergence');
    expect(getMastery(db, c.id)?.compression_stage).toBe(0);

    const again = createManualConcept(db, { sourceId, name: 'learning rate', definition_text: 'different' });
    expect(again.id).toBe(c.id);
    expect(getConceptById(db, c.id)?.definition_text).toBe('step size');
    expect(queryEvents(db).filter(e => e.type === 'concept.created')).toHaveLength(1);
    db.close();
  });
});

describe('rejectCandidate / rejectCandidatesBulk', () => {
  it('deletes the candidate and records a rejection event; unknown ids are a no-op', () => {
    const { db, sourceId } = setup();
    const id = addCandidate(db, sourceId, 'Noise');
    rejectCandidate(db, id);
    rejectCandidate(db, 12345);
    expect(getConceptCandidateById(db, id)).toBeNull();
    const rejections = queryEvents(db).filter(e => e.type === 'concept_candidate.rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ entityType: 'source', entityId: sourceId, payload: { candidateId: id, term: 'Noise' } });
    db.close();
  });

  it('counts only candidates that existed', () => {
    const { db, sourceId } = setup();
    const a = addCandidate(db, sourceId, 'Alpha');
    const b = addCandidate(db, sourceId, 'Beta');
    const keep = addCandidate(db, sourceId, 'Gamma');
    expect(rejectCandidatesBulk(db, [a, b, a, 999])).toEqual({ rejected: 2 });
    expect(listConceptCandidatesBySource(db, sourceId).map(c => c.id)).toEqual([keep]);
    db.close();
  });
});

describe('sourceHasStudyHistory', () => {
  it('is true only once a concept of that source has an evidence record', () => {
    const { db, sourceId } = setup();
    const other = createSource(db, { filename: 'b.txt', file_path: 'b.txt', title: 'B' });
    const c = plainConcept(db, sourceId, 'Bias', 'bias');
    expect(sourceHasStudyHistory(db, sourceId)).toBe(false);

    const task = createTask(db, { concept_id: c.id, kind: 'definition', prompt: 'Define bias.', difficulty: 1 });
    createEvidenceRecord(db, {
      task_id: task.id, concept_id: c.id, user_response: 'answer', score: 'gap', compression_stage: 0,
      gaps_detected: [], misconceptions_detected: [], grader_reasoning: '',
      task_prompt_snapshot: 'Define bias.', task_kind_snapshot: 'definition',
    });
    expect(sourceHasStudyHistory(db, sourceId)).toBe(true);
    expect(sourceHasStudyHistory(db, other.id)).toBe(false);
    db.close();
  });
});

describe('recoverInterruptedSources', () => {
  it('fails only sources stuck in processing and emits one event each', () => {
    const { db, sourceId } = setup();
    const ready = createSource(db, { filename: 'r.txt', file_path: 'r.txt', title: 'R' });
    updateSourceStatus(db, sourceId, 'processing');
    updateSourceStatus(db, ready.id, 'ready');

    expect(recoverInterruptedSources(db)).toEqual([sourceId]);
    const s = getSourceById(db, sourceId)!;
    expect(s.status).toBe('failed');
    expect(s.error_msg).toMatch(/interrupted/);
    expect(getSourceById(db, ready.id)!.status).toBe('ready');
    expect(queryEvents(db).filter(e => e.type === 'source.processing_interrupted')).toHaveLength(1);

    // Second boot: nothing left to recover.
    expect(recoverInterruptedSources(db)).toEqual([]);
    db.close();
  });
});
