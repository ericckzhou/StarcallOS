import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/llm', () => ({ chatJSON: vi.fn() }));

import { chatJSON } from '../core/llm';
import { openDb } from '../core/infra/db';
import { createSource } from '../knowledge/repos/sources';
import { createConcept } from '../knowledge/repos/concepts';
import { getConceptById } from '../knowledge/repos/concepts';
import { enrichConceptDefinition } from './enrich_concept';

const mockChat = vi.mocked(chatJSON);
const fakeUsage = { pass: 'enrich_concept', provider: 'groq' as const, model: 'm', promptTokens: 10, completionTokens: 20, totalTokens: 30, durationMs: 50 };
const cfg = { provider: 'groq' as const, apiKey: 'k', model: 'm' };

type DB = ReturnType<typeof openDb>;

function mockReply(fields: { definition_text?: unknown; why_exists?: unknown; what_breaks?: unknown }) {
  mockChat.mockResolvedValue({ content: JSON.stringify(fields), usage: fakeUsage });
}

function makeConcept(db: DB, sourceId: number, over: Partial<Parameters<typeof createConcept>[1]> = {}) {
  return createConcept(db, {
    source_id: sourceId,
    name: 'RAG',
    slug: 'rag',
    importance: 'core',
    definition_text: '',
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0.5,
    misconception_risk: 0.2,
    centrality_score: 0,
    ...over,
  });
}

function setup(over: Partial<Parameters<typeof createConcept>[1]> = {}) {
  const db = openDb(':memory:');
  const src = createSource(db, { filename: 'deep-learning.pdf', file_path: '/tmp/dl.pdf', title: 'Deep Learning', author: 'Goodfellow' });
  const concept = makeConcept(db, src.id, over);
  return { db, src, concept };
}

describe('enrichConceptDefinition', () => {
  beforeEach(() => mockChat.mockReset());

  it('throws when the concept does not exist', async () => {
    const db = openDb(':memory:');
    await expect(enrichConceptDefinition(cfg, db, 999)).rejects.toThrow(/concept 999 not found/);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('persists trimmed definition / why / what_breaks fields', async () => {
    const { db, concept } = setup();
    mockReply({
      definition_text: '  Retrieval-Augmented Generation.  ',
      why_exists: '  Grounds generations in retrieved context.  ',
      what_breaks: '  Hallucinations without grounding.  ',
    });

    const updated = await enrichConceptDefinition(cfg, db, concept.id);
    expect(updated.definition_text).toBe('Retrieval-Augmented Generation.');
    expect(updated.why_exists).toBe('Grounds generations in retrieved context.');
    expect(updated.what_breaks).toBe('Hallucinations without grounding.');
  });

  it('coerces missing fields to empty strings', async () => {
    const { db, concept } = setup();
    mockReply({ definition_text: 'Only a definition.' });
    const updated = await enrichConceptDefinition(cfg, db, concept.id);
    expect(updated.definition_text).toBe('Only a definition.');
    expect(updated.why_exists).toBe('');
    expect(updated.what_breaks).toBe('');
  });

  it('never writes where_reappears (constellations are user-curated)', async () => {
    const { db, concept } = setup({ where_reappears: [{ name: 'Attention', reason: 'shared mechanism' }] as never });
    mockReply({ definition_text: 'x', why_exists: 'y', what_breaks: 'z' });
    const updated = await enrichConceptDefinition(cfg, db, concept.id);
    expect(updated.where_reappears).toEqual([{ name: 'Attention', reason: 'shared mechanism' }]);
  });

  it('throws on invalid JSON without mutating the concept', async () => {
    const { db, concept } = setup({ definition_text: 'original' });
    mockChat.mockResolvedValue({ content: 'not json }{', usage: fakeUsage });
    await expect(enrichConceptDefinition(cfg, db, concept.id)).rejects.toThrow(/invalid JSON/);
    expect(getConceptById(db, concept.id)!.definition_text).toBe('original');
  });

  it('calls chatJSON with the "enrich_concept" pass name', async () => {
    const { db, concept } = setup();
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    expect(mockChat.mock.calls[0][2]).toBe('enrich_concept');
  });

  it('includes source title, author and section path in the prompt context', async () => {
    const { db, concept } = setup({ section_path: ['Chapter 6', '6.5 Back-Propagation'] });
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    const userMsg = mockChat.mock.calls[0][1].messages.find(m => m.role === 'user')!.content;
    expect(userMsg).toContain('Concept name: RAG');
    expect(userMsg).toContain('Source title: Deep Learning');
    expect(userMsg).toContain('Author: Goodfellow');
    expect(userMsg).toContain('Chapter 6 › 6.5 Back-Propagation');
  });

  it('does NOT pass the prior definition_text as an anchor', async () => {
    const { db, concept } = setup({ definition_text: 'Red/Amber/Green status (WRONG prior)' });
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    const userMsg = mockChat.mock.calls[0][1].messages.find(m => m.role === 'user')!.content;
    expect(userMsg).not.toContain('Red/Amber/Green status (WRONG prior)');
  });

  // ─── collectQuotes tier behavior ────────────────────────────────────────────

  it('uses evidence_json (tier 1) quotes for disambiguation', async () => {
    const { db, concept } = setup();
    db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?').run(
      JSON.stringify([{ quote: 'Retrieval-Augmented Generation combines a retriever with a generator.', page: 42 }]),
      concept.id,
    );
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    const userMsg = mockChat.mock.calls[0][1].messages.find(m => m.role === 'user')!.content;
    expect(userMsg).toContain('Verbatim quotes from THIS source');
    expect(userMsg).toContain('(p.42) Retrieval-Augmented Generation combines a retriever');
  });

  it('falls through to concept_candidates evidence (tier 2) when no evidence_json', async () => {
    const { db, src, concept } = setup();
    db.prepare(
      `INSERT INTO concept_candidates (source_id, term, normalized, confidence, evidence)
       VALUES (?, 'RAG', 'rag', 0.9, ?)`,
    ).run(src.id, JSON.stringify([{ quote: 'RAG retrieves passages before decoding.', page: 7 }]));
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    const userMsg = mockChat.mock.calls[0][1].messages.find(m => m.role === 'user')!.content;
    expect(userMsg).toContain('(p.7) RAG retrieves passages before decoding.');
  });

  it('omits the quotes section entirely when no evidence is available', async () => {
    const { db, concept } = setup();
    mockReply({ definition_text: 'd' });
    await enrichConceptDefinition(cfg, db, concept.id);
    const userMsg = mockChat.mock.calls[0][1].messages.find(m => m.role === 'user')!.content;
    expect(userMsg).not.toContain('Verbatim quotes from THIS source');
  });
});
