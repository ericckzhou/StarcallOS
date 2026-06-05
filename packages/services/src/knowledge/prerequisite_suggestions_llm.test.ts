import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/llm', () => ({ chatJSON: vi.fn() }));

import { chatJSON, type ProviderConfig, type UsageStats } from '../core/llm';
import { openDb } from '../core/infra/db';
import { createSource } from './repos/sources';
import { createConcept } from './repos/concepts';
import { suggestLlmPrerequisites, listPrerequisiteSuggestions } from './prerequisite_suggestions';

const mockChat = vi.mocked(chatJSON);
const config: ProviderConfig = { provider: 'groq', apiKey: 'k', model: 'm' };
const usage: UsageStats = {
  pass: 'prereq_suggest', provider: 'groq', model: 'm',
  promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0,
};

type DB = ReturnType<typeof openDb>;
function mk(db: DB, sourceId: number, name: string): number {
  return createConcept(db, {
    source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'),
    importance: 'core', definition_text: 'def', why_exists: '', what_breaks: '',
    where_reappears: [], chunk_ids: [], section_path: [],
    exam_value: 0, misconception_risk: 0, centrality_score: 0,
  }).id;
}

function reply(edges: Array<{ prerequisite?: string; dependent?: string }>) {
  return { content: JSON.stringify({ edges }), usage };
}

describe('suggestLlmPrerequisites', () => {
  it('maps {prerequisite, dependent} to a directed requires suggestion (basis llm), no edge written', async () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const bp = mk(db, s.id, 'Backpropagation');
    const cr = mk(db, s.id, 'Chain Rule');
    mockChat.mockResolvedValueOnce(reply([{ prerequisite: 'Chain Rule', dependent: 'Backpropagation' }]));

    const res = await suggestLlmPrerequisites(config, db, s.id);
    expect(res.created).toBe(1);
    const [sug] = listPrerequisiteSuggestions(db, s.id);
    expect(sug.from_id).toBe(cr); // prerequisite
    expect(sug.to_id).toBe(bp);   // dependent
    expect(sug.edge_type).toBe('requires');
    expect(sug.basis).toBe('llm');
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM concept_edges').get() as { c: number }).c)).toBe(0);
    db.close();
  });

  it('drops self-edges and names that do not resolve to a promoted concept', async () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mk(db, s.id, 'Backpropagation');
    mk(db, s.id, 'Chain Rule');
    mockChat.mockResolvedValueOnce(reply([
      { prerequisite: 'Backpropagation', dependent: 'Backpropagation' }, // self-edge
      { prerequisite: 'Nonexistent', dependent: 'Chain Rule' },          // unresolved
    ]));

    const res = await suggestLlmPrerequisites(config, db, s.id);
    expect(res.created).toBe(0);
    expect(res.skippedUnresolved).toBe(2);
    expect(listPrerequisiteSuggestions(db, s.id)).toEqual([]);
    db.close();
  });

  it('is a no-op with fewer than two concepts (never calls the LLM)', async () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    mk(db, s.id, 'Solo');
    mockChat.mockClear();
    const res = await suggestLlmPrerequisites(config, db, s.id);
    expect(res.created).toBe(0);
    expect(mockChat).not.toHaveBeenCalled();
    db.close();
  });
});
