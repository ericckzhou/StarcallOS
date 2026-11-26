import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('../core/llm')>()), chatJSON: vi.fn() }));

import { chatJSON, type ProviderConfig, type UsageStats } from '../core/llm';
import { openDb } from '../core/infra/db';
import { resolveAskConfig, type LLMSettings } from '../core/settings';
import type { BlockHint, SegmentedBlock } from '../ingestion/layout';
import type { RetrievedChunk } from './retrieval';
import { chunkBlocks } from '../ingestion/chunker';
import { createSource } from './repos/sources';
import { listSourceChunks, syncSourceChunks } from './repos/rag_chunks';
import {
  askSources, buildAskUserPrompt, quoteInPassage, retrievalQuery, rewriteMarkers, validateAnswer, withNeighbors, type AskPassage,
} from './ask';

const mockChat = vi.mocked(chatJSON);
const config: ProviderConfig = { provider: 'local', apiKey: '', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' };
const usage: UsageStats = {
  pass: 'ask', provider: 'local', model: 'llama3.1:8b',
  promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, retries: 0, cacheReadTokens: 0,
};
const reply = (o: unknown) => ({ content: JSON.stringify(o), usage });

function passage(n: number, text: string): AskPassage {
  return { n, chunk_id: 100 + n, source_id: 1, source_title: 'Notes', text, section_path: ['Ch 1'], page_start: n, page_end: n, score: 1 };
}

const P = [
  passage(1, 'Mathematical induction proves P(n) for all n by a basis case and an induction step.'),
  passage(2, 'The Kleene star of a language L is the set of all concatenations of zero or more strings of L.'),
];

const ok = (q: string, t: string) => quoteInPassage(q, t).ok;
const why = (q: string, t: string) => { const r = quoteInPassage(q, t); return r.ok ? 'ok' : r.reason; };

describe('quoteInPassage', () => {
  it('accepts exact quotes modulo case, whitespace, curly quotes and dashes', () => {
    expect(ok('proves P(n)   for ALL n', P[0].text)).toBe(true);
    expect(ok('a “basis case” — and', 'a "basis case" - and more text here')).toBe(true);
  });
  it('folds PDF epsilon glyphs (TeX maps ε to U+01EB) and line breaks', () => {
    const pdf = 'Formally, L⊛ is defined\n(by induction) as the smallest language such that:\nBasis: ǫ ∈ L⊛.';
    expect(ok('L⊛ is defined (by induction) as the smallest language such that: Basis: ε ∈ L⊛.', pdf)).toBe(true);
  });
  it('joins PDF line-break hyphens and folds the asterisk operator (real b36 text)', () => {
    const pdf = 'Regular expressions contain three operators: alternation +, informally meaning “or”; con-\ncatenation, informally meaning “followed by”; and repetition ∗, informally meaning “zero or\nmore repetitions of”.';
    expect(ok("alternation +, informally meaning 'or'; concatenation, informally meaning 'followed by'; and repetition *", pdf)).toBe(true);
    expect(ok('then (R + S), (RS) and R* also belong to RE', 'Induction Step: If R and S belong to RE, then (R + S), (RS) and R∗ also belong to RE.')).toBe(true);
  });
  it('treats compounds symmetrically but leaves spaced minus signs alone', () => {
    expect(ok('a well-known result in algebra', 'This is a well-\nknown result in algebra.')).toBe(true);
    expect(ok('a well-known result in algebra', 'This is a well-known result in algebra.')).toBe(true);
    expect(ok('compute x - y for every pair', 'We compute xy for every pair.')).toBe(false);
  });
  it('accepts in-order ellipsis pieces and rejects out-of-order ones', () => {
    expect(ok('The Kleene star … zero or more strings', P[1].text)).toBe(true);
    expect(why('zero or more strings ... The Kleene star', P[1].text)).toBe('quote_not_found');
  });
  it('rejects paraphrases and too-short quotes', () => {
    expect(why('induction proves statements for every natural number', P[0].text)).toBe('quote_not_found');
    expect(why('the set', P[1].text)).toBe('quote_too_short');
  });
  it('reports the verified span in ORIGINAL passage offsets', () => {
    const text = 'Intro.\n\nThe  BASIS   case\nholds; ǫ is empty.';
    const r = quoteInPassage('the basis case holds; ε is empty', text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(text.slice(r.start, r.end)).toBe('The  BASIS   case\nholds; ǫ is empty');
  });
});

describe('rewriteMarkers', () => {
  it('keeps verified markers, drops the rest, and tidies spacing', () => {
    const r = rewriteMarkers('Induction has two parts [1, 3]. Kleene star repeats [3].', new Set([1]));
    expect(r.text).toBe('Induction has two parts [1]. Kleene star repeats.');
    expect(r.droppedMarkers).toEqual([3, 3]);
  });
});

describe('validateAnswer', () => {
  it('is grounded when every marker has a verified quote', () => {
    const v = validateAnswer({
      answer: 'Induction needs a basis case and an induction step [1].',
      citations: [{ passage: 1, quote: 'a basis case and an induction step' }],
      insufficient: false,
    }, P);
    expect(v.status).toBe('grounded');
    expect(v.citations).toHaveLength(1);
    expect(v.citations[0]).toMatchObject({ n: 1, chunk_id: 101, page_start: 1 });
    expect(P[0].text.slice(v.citations[0].start, v.citations[0].end)).toBe('a basis case and an induction step');
  });

  it('is partial when one citation is fabricated, and strips its marker', () => {
    const v = validateAnswer({
      answer: 'Induction has a basis case [1]. It was invented by Euclid [2].',
      citations: [
        { passage: 1, quote: 'by a basis case and an induction step' },
        { passage: 2, quote: 'invented by Euclid' },
      ],
      insufficient: false,
    }, P);
    expect(v.status).toBe('partial');
    expect(v.answer).toBe('Induction has a basis case [1]. It was invented by Euclid.');
    expect(v.dropped).toEqual([{ n: 2, quote: 'invented by Euclid', reason: 'quote_not_found' }]);
  });

  it('flags markers with no quote and citations to unknown passages', () => {
    const v = validateAnswer({
      answer: 'Something [1] and more [9].',
      citations: [{ passage: 9, quote: 'a quote from nowhere at all' }],
      insufficient: false,
    }, P);
    expect(v.status).toBe('unsupported');
    expect(v.answer).toBe('Something and more.');
    expect(v.dropped.map(d => d.reason).sort()).toEqual(['marker_without_quote', 'unknown_passage']);
  });

  it('honors the insufficient flag', () => {
    const v = validateAnswer({ answer: 'The passages do not cover this.', citations: [], insufficient: true }, P);
    expect(v.status).toBe('insufficient');
    // A hedged answer with a verified citation is a caveated answer, not a decline.
    const q = validateAnswer({
      answer: 'The passages only define the Kleene star [2].', citations: [{ passage: 2, quote: 'concatenations of zero or more strings' }], insufficient: true,
    }, P);
    expect(q.status).toBe('qualified');
    expect(q.citations).toHaveLength(1);
    // ...but only when a citation survives verification.
    const u = validateAnswer({ answer: 'Maybe [1].', citations: [{ passage: 1, quote: 'not in the passage at all' }], insufficient: true }, P);
    expect(u.status).toBe('insufficient');
  });
});

describe('retrievalQuery', () => {
  it('appends the focus concept unless the question already names it', () => {
    expect(retrievalQuery('Why does it exist?', 'Kleene star')).toBe('Why does it exist? Kleene star');
    expect(retrievalQuery('What is the KLEENE   star?', 'Kleene star')).toBe('What is the KLEENE   star?');
    expect(retrievalQuery('What is it?', null)).toBe('What is it?');
  });
});

describe('buildAskUserPrompt', () => {
  it('numbers passages with source, section and page', () => {
    const s = buildAskUserPrompt('What is induction?', P);
    expect(s).toContain('[1] (Notes | Ch 1 | p. 1)');
    expect(s).toContain('[2] (Notes | Ch 1 | p. 2)');
    expect(s.endsWith('Question: What is induction?')).toBe(true);
  });
});

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}
function seed() {
  const db = openDb(':memory:');
  const s = createSource(db, { filename: 'b36.pdf', file_path: 'b36.pdf', title: 'B36 notes' });
  order = 0;
  syncSourceChunks(db, s.id, chunkBlocks([
    blk('Induction', 4, 'heading'),
    blk('Mathematical induction proves P(n) for all n by a basis case and an induction step.', 4),
  ]).chunks);
  return { db, s };
}

describe('askSources', () => {
  beforeEach(() => mockChat.mockReset());

  it('maps citations back to chunks and pages', async () => {
    const { db, s } = seed();
    mockChat.mockResolvedValueOnce(reply({
      answer: 'It uses a basis case and an induction step [1].',
      citations: [{ passage: 1, quote: 'a basis case and an induction step' }],
      insufficient: false,
    }));
    const r = await askSources(db, { question: 'How does induction work?', sourceIds: [s.id], config });
    expect(r.status).toBe('grounded');
    expect(r.retrieval.mode_used).toBe('keyword');
    expect(r.citations[0]).toMatchObject({ n: 1, source_id: s.id, page_start: 4 });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][2]).toBe('ask');
  });

  it('uses the focus for retrieval only, never in the prompt', async () => {
    const { db, s } = seed();
    mockChat.mockResolvedValueOnce(reply({ answer: 'x', citations: [], insufficient: true }));
    // "step" alone matches; the focus must not leak into the user prompt.
    const r = await askSources(db, { question: 'What is the step?', sourceIds: [s.id], config, focus: 'Mathematical induction' });
    expect(r.focus).toBe('Mathematical induction');
    expect(r.passages).toHaveLength(1);
    const userMsg = (mockChat.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }).messages[1].content;
    expect(userMsg.endsWith('Question: What is the step?')).toBe(true);
  });

  it('makes no model call when retrieval finds nothing', async () => {
    const { db, s } = seed();
    const r = await askSources(db, { question: 'photosynthesis chlorophyll', sourceIds: [s.id], config });
    expect(r.status).toBe('no_passages');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('degrades to retrieval_only when the local server is offline', async () => {
    const { db, s } = seed();
    mockChat.mockRejectedValueOnce(new Error('fetch failed'));
    const r = await askSources(db, { question: 'induction step', sourceIds: [s.id], config });
    expect(r.status).toBe('retrieval_only');
    expect(r.generation_error).toBe('fetch failed');
    expect(r.passages).toHaveLength(1);
  });

  it('drops a bare "insufficient" answer so the UI shows its own message', async () => {
    const { db, s } = seed();
    mockChat.mockResolvedValueOnce(reply({ answer: 'insufficient', citations: [], insufficient: true }));
    const r = await askSources(db, { question: 'induction step', sourceIds: [s.id], config });
    expect(r.status).toBe('insufficient');
    expect(r.answer).toBeNull();
  });

  it('returns passages only when no local model is configured', async () => {
    const { db, s } = seed();
    const r = await askSources(db, { question: 'induction step', sourceIds: [s.id], config: null });
    expect(r.status).toBe('retrieval_only');
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('resolveAskConfig', () => {
  const base: LLMSettings = { provider: 'anthropic', groqApiKey: '', anthropicApiKey: 'sk-secret' };
  it('never returns a cloud provider', () => {
    expect(resolveAskConfig({ ...base, localModel: 'qwen3:8b' })).toMatchObject({ provider: 'local', model: 'qwen3:8b', apiKey: '' });
    expect(resolveAskConfig(base)).toBeNull();
    expect(resolveAskConfig({ ...base, provider: 'local' })?.provider).toBe('local');
  });
});

describe('withNeighbors', () => {
  // Two sections; long blocks so each section splits into several chunks.
  function seedLong() {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'n.pdf', file_path: 'n.pdf', title: 'N' });
    order = 0;
    const para = (w: string) => `${w} `.repeat(160).trim() + '.';
    syncSourceChunks(db, s.id, chunkBlocks([
      blk('Section A', 1, 'heading'), blk(para('alpha'), 1), blk(para('beta'), 1), blk(para('gamma'), 2),
      blk('Section B', 3, 'heading'), blk(para('delta'), 3), blk(para('epsilon'), 3),
    ]).chunks);
    return { db, rows: listSourceChunks(db, s.id) };
  }
  const hit = (c: { id: number; chunk_key: string; text: string; source_id: number }, score: number): RetrievedChunk => ({
    chunk_id: c.id, chunk_key: c.chunk_key, source_id: c.source_id, source_title: 'N', text: c.text, heading: null,
    section_path: [], page_start: 1, page_end: 1, has_formula: false, score,
    keyword_rank: 1, keyword_score: 1, vector_rank: 1, vector_similarity: 0.9,
  });

  it('inserts the in-section follower of the top hits right after them', () => {
    const { db, rows } = seedLong();
    const a = rows.filter(r => r.section_text.includes('Section A'));
    const b = rows.filter(r => r.section_text.includes('Section B'));
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(b.length).toBeGreaterThanOrEqual(2);
    // top hits: A0, B0, then the rest of B / A in some order
    const hits = [hit(a[0], 0.9), hit(b[0], 0.8), hit(b[1], 0.7), hit(a[2], 0.6), hit(a[1], 0.5)];
    const out = withNeighbors(db, hits, 4).map(h => h.chunk_id);
    // base = top 2 (k - 2 anchors): A0 + its follower A1, B0 + its follower B1
    expect(out).toEqual([a[0].id, a[1].id, b[0].id, b[1].id]);
  });

  it('never crosses a section boundary or duplicates a passage', () => {
    const { db, rows } = seedLong();
    const a = rows.filter(r => r.section_text.includes('Section A'));
    const last = a[a.length - 1];
    const out = withNeighbors(db, [hit(last, 0.9), hit(a[0], 0.8)], 6);
    expect(out.map(h => h.chunk_id)).toEqual([last.id, a[0].id, a[1].id]);
    expect(new Set(out.map(h => h.chunk_id)).size).toBe(out.length);
  });

  it('is a plain top-k cut for small k', () => {
    const { db, rows } = seedLong();
    const hits = rows.slice(0, 3).map((r, i) => hit(r, 1 - i / 10));
    expect(withNeighbors(db, hits, 3).map(h => h.chunk_id)).toEqual(rows.slice(0, 3).map(r => r.id));
  });
});
