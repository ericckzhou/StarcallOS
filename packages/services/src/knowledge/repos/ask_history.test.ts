import { describe, it, expect } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept } from './concepts';
import { ASK_HISTORY_LIMIT, deleteAskHistory, listAskHistory, saveAskHistory } from './ask_history';
import type { AskResult } from '../ask';

function seed() {
  const db = openDb(':memory:');
  const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
  const c = createConcept(db, {
    source_id: s.id, name: 'Induction', slug: 'induction', importance: 'core', definition_text: '',
    why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [], section_path: [],
    exam_value: 0, misconception_risk: 0, centrality_score: 0,
  });
  return { db, conceptId: c.id };
}

function result(question: string): AskResult {
  return {
    question, status: 'grounded', answer: 'A [1].', model: 'm', focus: 'Induction',
    citations: [{ n: 1, chunk_id: 1, source_id: 1, page_start: 2, page_end: 2, quote: 'a basis case', start: 3, end: 15 }],
    dropped: [], passages: [],
    retrieval: { mode_requested: 'hybrid', mode_used: 'keyword', vector_error: null },
    generation_error: null,
  };
}

describe('ask_history', () => {
  it('round-trips the full result, newest first', () => {
    const { db, conceptId } = seed();
    saveAskHistory(db, conceptId, result('first?'));
    const second = saveAskHistory(db, conceptId, result('second?'));
    const list = listAskHistory(db, conceptId);
    expect(list.map(h => h.result.question)).toEqual(['second?', 'first?']);
    expect(list[0].id).toBe(second.id);
    expect(list[0].result.citations[0]).toMatchObject({ start: 3, end: 15 });
  });

  it('keeps only the newest ASK_HISTORY_LIMIT entries per concept', () => {
    const { db, conceptId } = seed();
    for (let i = 0; i < ASK_HISTORY_LIMIT + 3; i++) saveAskHistory(db, conceptId, result(`q${i}`));
    const list = listAskHistory(db, conceptId);
    expect(list).toHaveLength(ASK_HISTORY_LIMIT);
    expect(list[0].result.question).toBe(`q${ASK_HISTORY_LIMIT + 2}`);
    expect(list.some(h => h.result.question === 'q0')).toBe(false);
  });

  it('deletes one entry, and all of them with the concept', () => {
    const { db, conceptId } = seed();
    const a = saveAskHistory(db, conceptId, result('a?'));
    saveAskHistory(db, conceptId, result('b?'));
    deleteAskHistory(db, a.id);
    expect(listAskHistory(db, conceptId).map(h => h.result.question)).toEqual(['b?']);
    db.prepare('DELETE FROM concepts WHERE id = ?').run(conceptId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ask_history').get()).toEqual({ n: 0 });
  });
});
