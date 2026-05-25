import { describe, it, expect } from 'vitest';
import { openDb } from '../core/infra/db';
import type { SegmentedBlock } from '../ingestion/layout';
import { createConceptCandidate, listConceptCandidatesBySource } from './repos/candidates';
import { createSource, getTopicAnchors, setTopicAnchors } from './repos/sources';
import { createConcept, getConceptById, listConceptsBySource, listConceptSourceEvidence } from './repos/concepts';
import { createEvidenceRecord, createTask, getMastery } from './repos/evidence';
import { createNote, listNotesByConcept } from './repos/concept_notes';
import { promoteCandidate } from './promotion';
import { clearDerivedDataForSource } from './cleanup';
import { deriveTopicAnchors } from '../core/topic';

function block(partial: Partial<SegmentedBlock> & { text: string; page?: number; readingOrder: number }): SegmentedBlock {
  return {
    text: partial.text,
    page: partial.page ?? 1,
    readingOrder: partial.readingOrder,
    hint: partial.hint ?? 'body',
    hintConfidence: partial.hintConfidence ?? 2,
    signals: partial.signals ?? {
      fontSizeRatio: 1,
      yGapAbove: 0,
      xColumnIndex: 0,
      isIsolatedLine: false,
      isAllCaps: false,
      isBold: false,
    },
  };
}

function seedCandidates(db: ReturnType<typeof openDb>) {
  const source = createSource(db, {
    filename: 'optimization.txt',
    file_path: 'optimization.txt',
    title: 'Optimization for Neural Networks',
  });
  const blocks = [
    block({ text: '# Gradient Descent', page: 3, readingOrder: 0, hint: 'heading' }),
    block({
      text: 'Gradient Descent is defined as an iterative optimization method that updates parameters opposite the gradient.',
      page: 3,
      readingOrder: 1,
    }),
    block({
      text: 'Gradient Descent requires a differentiable objective and a learning rate.',
      page: 4,
      readingOrder: 2,
    }),
  ];
  const anchors = deriveTopicAnchors(blocks, source.title);
  setTopicAnchors(db, source.id, anchors);
  createConceptCandidate(db, source.id, {
    term: 'Gradient Descent',
    normalized: 'gradient descent',
    confidence: 0.95,
    evidence: [
      { source: 'heading', quote: '# Gradient Descent', page: 3 },
      {
        source: 'definition_pattern',
        quote: 'Gradient Descent is defined as an iterative optimization method that updates parameters opposite the gradient.',
        page: 3,
        pattern: 'is_defined_as',
      },
      {
        source: 'repetition',
        quote: 'appears 6x',
        page: 4,
      },
    ],
    section_path: ['Gradient Descent'],
    first_page: 3,
    mention_count: 3,
    topic_relevance_score: 0.75,
    topic_relevance_reasons: ['term: gradient'],
    is_boilerplate: false,
    is_broad: false,
    concept_score: 0,
    reject_reasons: [],
  });
  createConceptCandidate(db, source.id, {
    term: 'Momentum',
    normalized: 'momentum',
    confidence: 0.55,
    evidence: [{ source: 'heading', quote: 'Momentum', page: 5 }],
    section_path: ['Momentum'],
    first_page: 5,
    mention_count: 1,
    topic_relevance_score: 0.5,
    topic_relevance_reasons: [],
    is_boilerplate: false,
    is_broad: false,
    concept_score: 0,
    reject_reasons: [],
  });
  return { source, candidates: listConceptCandidatesBySource(db, source.id) };
}

describe('candidate promotion and cleanup', () => {
  it('promotes a candidate with real evidence, mastery, and durable source spans', () => {
    const db = openDb(':memory:');
    const { source, candidates } = seedCandidates(db);
    const candidate = candidates.find(c => c.normalized === 'gradient descent');
    expect(candidate).toBeDefined();

    const concept = promoteCandidate(db, candidate!.id);

    expect(concept.name).toBe('Gradient Descent');
    expect(concept.importance).toBe(candidate!.confidence >= 0.9 ? 'core' : 'supporting');
    expect(concept.definition_text).toContain('iterative optimization method');
    expect(getMastery(db, concept.id)?.compression_stage).toBe(0);
    expect(listConceptCandidatesBySource(db, source.id).some(c => c.id === candidate!.id)).toBe(false);

    const row = db
      .prepare('SELECT evidence_json FROM concepts WHERE id = ?')
      .get(concept.id) as { evidence_json: string };
    const spans = JSON.parse(row.evidence_json) as Array<{ source: string; quote: string; page: number }>;
    expect(spans.some(s => s.source === 'definition_pattern' && s.page === 3)).toBe(true);

    const sourceEvidence = listConceptSourceEvidence(db, concept.id);
    expect(sourceEvidence?.sourceId).toBe(source.id);
    expect(sourceEvidence?.evidence.some(e =>
      e.kind === 'definition' &&
      e.page === 3 &&
      e.quote?.includes('iterative optimization method'),
    )).toBe(true);

    db.close();
  });

  it('preserves promoted and studied concepts while clearing derived extraction artifacts', () => {
    const db = openDb(':memory:');
    const { source, candidates } = seedCandidates(db);
    const promoted = promoteCandidate(db, candidates.find(c => c.normalized === 'gradient descent')!.id);

    const llmUntouched = createConcept(db, {
      source_id: source.id,
      name: 'LLM Untouched',
      slug: 'llm-untouched',
      importance: 'supporting',
      definition_text: 'Temporary LLM concept.',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0,
    });
    const studied = createConcept(db, {
      source_id: source.id,
      name: 'Studied LLM Concept',
      slug: 'studied-llm-concept',
      importance: 'supporting',
      definition_text: 'A concept with user history.',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0,
    });
    const task = createTask(db, {
      concept_id: studied.id,
      kind: 'definition',
      prompt: 'Define it.',
      difficulty: 1,
    });
    createEvidenceRecord(db, {
      task_id: task.id,
      concept_id: studied.id,
      user_response: 'A studied answer.',
      score: 'understood',
      compression_stage: 2,
      gaps_detected: [],
      misconceptions_detected: [],
      grader_reasoning: 'Good enough for preservation.',
      task_prompt_snapshot: 'Define it.',
      task_kind_snapshot: 'definition',
    });

    const counts = clearDerivedDataForSource(db, source.id);

    expect(counts.concepts_preserved).toBe(2);
    expect(getConceptById(db, promoted.id)).not.toBeNull();
    expect(getConceptById(db, studied.id)).not.toBeNull();
    expect(getConceptById(db, llmUntouched.id)).toBeNull();
    expect(listConceptCandidatesBySource(db, source.id)).toEqual([]);

    const remainingNames = listConceptsBySource(db, source.id).map(c => c.name).sort();
    expect(remainingNames).toEqual(['Gradient Descent', 'Studied LLM Concept']);
    expect(getTopicAnchors(db, source.id).length).toBeGreaterThan(0);

    db.close();
  });
});

describe('cleanup preserves user-authored notes on surviving concepts', () => {
  it('keeps notes on a studied concept, drops notes only when the concept itself is dropped', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'b.txt', file_path: 'b.txt' });

    const studied = createConcept(db, {
      source_id: source.id,
      name: 'Studied',
      slug: 'studied',
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
    });
    const task = createTask(db, { concept_id: studied.id, kind: 'definition', prompt: 'q', difficulty: 1 });
    createEvidenceRecord(db, {
      task_id: task.id,
      concept_id: studied.id,
      user_response: 'a',
      score: 'understood',
      compression_stage: 2,
      gaps_detected: [],
      misconceptions_detected: [],
      grader_reasoning: 'ok',
      task_prompt_snapshot: 'q',
      task_kind_snapshot: 'definition',
    });
    createNote(db, studied.id, { heading: 'my followup', body: 'check chapter 8' });

    const orphan = createConcept(db, {
      source_id: source.id,
      name: 'Orphan',
      slug: 'orphan',
      importance: 'peripheral',
      definition_text: '',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0,
    });
    createNote(db, orphan.id, { heading: 'doomed', body: '' });

    clearDerivedDataForSource(db, source.id, { preserveUserData: true });

    expect(listNotesByConcept(db, studied.id).map(n => n.heading)).toEqual(['my followup']);
    expect(getConceptById(db, orphan.id)).toBeNull();
    expect(listNotesByConcept(db, orphan.id)).toEqual([]);

    db.close();
  });
});
