import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { CONTENT_NOTICE, TOOLS, toolsForScopes, type ToolContext } from './tools';
import { ALL_SCOPES, DEFAULT_SCOPES, type Scope } from './config';
import { openFixtureReadOnly, seedFixture, topicEmbedder, type Fixture } from './fixture.test-helper';

let f: Fixture;
let db: DatabaseSync;

beforeAll(async () => {
  f = await seedFixture();
  db = openFixtureReadOnly(f); // every tool below runs against a READ-ONLY handle
});
afterAll(() => {
  db.close();
  f.cleanup();
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  db, embedder: null, embedderNote: 'Embeddings disabled (--no-embeddings).',
  scopes: new Set<Scope>(DEFAULT_SCOPES), now: () => new Date('2026-11-27T12:00:00Z'), ...over,
});
const tool = (name: string) => TOOLS.find(t => t.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (name: string, args: Record<string, unknown> = {}, c = ctx()): Promise<any> => tool(name).run(c, args);

describe('scopes', () => {
  it('exposes highlights only when opted in and keeps default scopes small', () => {
    expect(DEFAULT_SCOPES).not.toContain('highlights');
    expect(DEFAULT_SCOPES).not.toContain('notes');
    const names = (s: Scope[]) => toolsForScopes(new Set(s)).map(t => t.name);
    expect(names(DEFAULT_SCOPES)).not.toContain('search_highlights');
    expect(names([...DEFAULT_SCOPES, 'highlights'])).toEqual(expect.arrayContaining(['search_highlights', 'get_highlight']));
    expect(names(['progress'])).toEqual(['get_learning_progress']);
  });
});

describe('search_passages', () => {
  it('falls back to keyword search and says why when embeddings are off', async () => {
    const out = await run('search_passages', { query: 'oxidative phosphorylation' });
    expect(out.mode_used).toBe('keyword');
    expect(out.vector_note).toMatch(/disabled/);
    expect(out.notice).toBe(CONTENT_NOTICE);
    expect(out.results[0]).toMatchObject({ source_id: f.ids.bio, source_title: 'Cell Biology', page_start: 7 });
    expect(typeof out.results[0].chunk_id).toBe('number');
    expect(out.results[0].keyword_rank).toBe(1);
    expect(out.results[0].vector_rank).toBeNull();
  });

  it('uses hybrid retrieval with a loopback embedder and finds paraphrases', async () => {
    const out = await run('search_passages', { query: 'how unpredictable is a variable', limit: 3 },
      ctx({ embedder: topicEmbedder(), embedderNote: null }));
    expect(out.mode_used).toBe('hybrid');
    expect(out.vector_note).toBeUndefined();
    expect(out.results.some((r: { text: string }) => /Entropy measures/.test(r.text))).toBe(true);
    type Ranked = { keyword_rank: number | null; vector_rank: number | null };
    expect(out.results.every((r: Ranked) => r.vector_rank !== null)).toBe(true);
    expect(out.results.every((r: Ranked) => r.keyword_rank === null || r.keyword_rank >= 1)).toBe(true);
  });

  it('can be limited to one source', async () => {
    const out = await run('search_passages', { query: 'gradient entropy mitochondrion', source_id: f.ids.bio });
    expect(out.results.every((r: { source_id: number }) => r.source_id === f.ids.bio)).toBe(true);
  });
});

describe('get_passage and list_sources', () => {
  it('returns a passage with neighbours and attribution', async () => {
    const hit = (await run('search_passages', { query: 'gradient descent slope' })).results[0];
    const out = await run('get_passage', { chunk_id: hit.chunk_id, neighbors: 1 });
    expect(out.source_title).toBe('Machine Learning Notes');
    expect(out.passages.filter((p: { is_requested: boolean }) => p.is_requested)).toHaveLength(1);
    await expect(Promise.resolve().then(() => run('get_passage', { chunk_id: 999999 }))).rejects.toThrow(/No passage/);
  });

  it('lists sources without exposing local file paths', async () => {
    const out = await run('list_sources');
    expect(out.sources.map((s: { title: string }) => s.title)).toEqual(['Machine Learning Notes', 'Cell Biology']);
    expect(out.sources[0]).toMatchObject({ concept_count: 2, filename: 'ml.pdf' });
    expect(out.sources[0].passage_count).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain('C:/Users/someone');
  });
});

describe('concepts', () => {
  it('finds concepts by any word and reports where it matched', async () => {
    const out = await run('search_concepts', { query: 'descent' });
    expect(out.results[0]).toMatchObject({ concept_id: f.ids.gradient, name: 'Gradient descent', matched_in: ['name'], mastery_stage: 0 });
  });

  it('returns evidence, prerequisites and progress; notes only when opted in', async () => {
    const out = await run('get_concept', { concept_id: f.ids.gradient });
    expect(out).toMatchObject({ name: 'Gradient descent', source_title: 'Machine Learning Notes' });
    expect(out.prerequisites.learn_first.map((n: { name: string }) => n.name)).toEqual(['Entropy']);
    expect(out.progress).toMatchObject({ attempts: 0, mastery_stage: 0, review: null });
    expect(out.notes).toBeUndefined();

    const withNotes = await run('get_concept', { concept_id: f.ids.entropy }, ctx({ scopes: new Set<Scope>([...DEFAULT_SCOPES, 'notes']) }));
    expect(withNotes.notes[0]).toMatchObject({ heading: 'My take' });
    expect(withNotes.prerequisites.unlocks.map((n: { name: string }) => n.name)).toEqual(['Gradient descent']);

    const noProgress = await run('get_concept', { concept_id: f.ids.entropy }, ctx({ scopes: new Set<Scope>(['concepts']) }));
    expect(noProgress.progress).toBeUndefined();
  });
});

describe('get_learning_progress', () => {
  it('summarises progress and review state', async () => {
    const out = await run('get_learning_progress');
    expect(out).toMatchObject({ level: 1, total_xp: 0, challenges_completed: 0 });
    expect(out.review).toMatchObject({ due_now: 0, new: 2 });
  });
});

describe('highlights', () => {
  const hl = () => ctx({ scopes: new Set<Scope>([...DEFAULT_SCOPES, 'highlights']) });

  it('searches persisted highlights with attribution and never returns sticky notes', async () => {
    const out = await run('search_highlights', { query: 'ATP' }, hl());
    expect(out.results.map((r: { highlight_id: number }) => r.highlight_id)).toEqual([f.ids.highlight]);
    expect(out.results[0]).toMatchObject({
      source_id: f.ids.bio, source_title: 'Cell Biology', page: 7, label: 'key mechanism', created_from: 'manual_selection',
    });
    expect(out.results[0].created_at).toBeTruthy();
    expect(out.results[0].note).toBeUndefined(); // note body needs the notes scope
  });

  it('returns the surrounding passage for a highlight', async () => {
    const out = await run('get_highlight', { highlight_id: f.ids.highlight }, hl());
    expect(out.context_match).toBe('contains_highlight');
    expect(out.context[0].text).toMatch(/oxidative phosphorylation/);
    await expect(Promise.resolve().then(() => run('get_highlight', { highlight_id: f.ids.stickyNote }, hl())))
      .rejects.toThrow(/No highlight/);
  });
});

describe('secrets', () => {
  it('never returns API keys or settings, whatever is enabled', async () => {
    const all = ctx({ scopes: new Set<Scope>(ALL_SCOPES) });
    const outputs = [
      await run('search_passages', { query: 'entropy' }, all),
      await run('list_sources', {}, all),
      await run('search_concepts', { query: 'entropy' }, all),
      await run('get_concept', { concept_id: f.ids.entropy }, all),
      await run('get_learning_progress', {}, all),
      await run('search_highlights', { query: '' }, all),
      await run('get_highlight', { highlight_id: f.ids.highlight }, all),
    ];
    const text = JSON.stringify(outputs);
    expect(text).not.toMatch(/FAKE_SECRET|FAKE-SECRET|ApiKey|apiKey/);
  });
});
