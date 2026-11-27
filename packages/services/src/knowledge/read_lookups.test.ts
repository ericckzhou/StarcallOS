// Read-only lookups added for the MCP reader: tokenized concept search,
// highlight search/get, page/window chunk lookups, chunk embedding models, and
// the embedder's refusal to follow redirects.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../core/infra/db';
import { createOpenAICompatEmbedder } from '../core/embeddings';
import type { BlockHint, SegmentedBlock } from '../ingestion/layout';
import { chunkBlocks } from '../ingestion/chunker';
import { createSource } from './repos/sources';
import { conceptSearchTokens, createConcept, searchConcepts } from './repos/concepts';
import { createPdfAnnotation, getHighlight, searchHighlights, softDeletePdfAnnotation } from './repos/pdf_annotations';
import { chunkEmbeddingModels, getChunkWindow, listChunksOnPage, listSourceChunks, syncSourceChunks } from './repos/rag_chunks';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}

function concept(db: ReturnType<typeof openDb>, sourceId: number, name: string, definition: string, centrality = 0) {
  return createConcept(db, {
    source_id: sourceId, name, slug: name.toLowerCase().replace(/\W+/g, '-'), importance: 'core',
    definition_text: definition, why_exists: '', what_breaks: '', where_reappears: [], chunk_ids: [],
    section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: centrality,
  }, 'promoted');
}

describe('searchConcepts', () => {
  it('drops stopwords and duplicates from the query', () => {
    expect(conceptSearchTokens('What is the gradient of the Gradient?')).toEqual(['gradient']);
  });

  it('matches words anywhere in the name, ranking name hits above definition hits', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'ml.pdf', file_path: 'ml.pdf', title: 'ML notes' });
    concept(db, s.id, 'Gradient descent', 'Iteratively steps against the gradient to minimise a loss.');
    concept(db, s.id, 'Learning rate', 'Step size used by gradient descent.');
    concept(db, s.id, 'Entropy', 'Expected surprise of a distribution.');

    const hits = searchConcepts(db, 'descent');
    expect(hits.map(h => h.concept.name)).toEqual(['Gradient descent', 'Learning rate']);
    expect(hits[0].matched_in).toEqual(['name']);
    expect(hits[1].matched_in).toEqual(['definition']);
    expect(hits[0].source_title).toBe('ML notes');
    expect(searchConcepts(db, 'what is the')).toEqual([]);
    expect(searchConcepts(db, '100%_off')).toEqual([]);
  });
});

describe('highlights', () => {
  it('returns live persisted highlights with source and concept attribution, never sticky notes', () => {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'bio.pdf', file_path: 'bio.pdf', title: 'Biology' });
    const c = concept(db, s.id, 'Mitochondria', 'Organelle that makes ATP.');
    const rect = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }];
    const h = createPdfAnnotation(db, {
      sourceId: s.id, conceptId: c.id, scope: 'concept', type: 'highlight', createdFrom: 'manual_selection',
      page: 7, selectedText: 'The mitochondrion produces ATP through oxidative phosphorylation.', rects: rect,
    });
    createPdfAnnotation(db, {
      sourceId: s.id, type: 'note', createdFrom: 'manual_note', page: 7, noteBody: 'ATP reminder', rects: rect,
    });
    const gone = createPdfAnnotation(db, {
      sourceId: s.id, type: 'highlight', createdFrom: 'manual_selection', page: 9, selectedText: 'ATP synthase', rects: rect,
    });
    softDeletePdfAnnotation(db, gone.id);

    const hits = searchHighlights(db, 'ATP');
    expect(hits.map(x => x.annotation.id)).toEqual([h.id]);
    expect(hits[0]).toMatchObject({ source_title: 'Biology', concept_name: 'Mitochondria' });
    expect(hits[0].annotation).toMatchObject({ page: 7, source_id: s.id, concept_id: c.id });
    expect(searchHighlights(db, 'mitochondria oxidative')).toHaveLength(1);
    expect(searchHighlights(db, 'ribosome')).toHaveLength(0);
    expect(searchHighlights(db, '')).toHaveLength(1);
    expect(getHighlight(db, h.id)?.annotation.selected_text).toMatch(/oxidative/);
    expect(getHighlight(db, gone.id)).toBeNull();
  });
});

describe('chunk lookups', () => {
  function seed() {
    const db = openDb(':memory:');
    const s = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf', title: 'A' });
    order = 0;
    syncSourceChunks(db, s.id, chunkBlocks([
      blk('One', 1, 'heading'), blk('First page body text about induction proofs and base cases.', 1),
      blk('Two', 2, 'heading'), blk('Second page body text about trees, nodes and parent edges.', 2),
      blk('Three', 3, 'heading'), blk('Third page body text about regular languages and the Kleene star.', 3),
    ]).chunks);
    return { db, s };
  }

  it('finds the chunks covering a page', () => {
    const { db, s } = seed();
    const onTwo = listChunksOnPage(db, s.id, 2);
    expect(onTwo.length).toBeGreaterThan(0);
    expect(onTwo.every(c => c.page_start <= 2 && c.page_end >= 2)).toBe(true);
    expect(listChunksOnPage(db, s.id, 99)).toEqual([]);
  });

  it('returns a reading-order window around a chunk', () => {
    const { db, s } = seed();
    const all = listSourceChunks(db, s.id);
    const mid = all[Math.floor(all.length / 2)];
    const win = getChunkWindow(db, mid.id, 1);
    expect(win.map(c => c.id)).toContain(mid.id);
    expect(win.length).toBeLessThanOrEqual(3);
    expect(win.map(c => c.ordinal)).toEqual([...win.map(c => c.ordinal)].sort((a, b) => a - b));
    expect(getChunkWindow(db, 999_999, 1)).toEqual([]);
  });

  it('lists chunk embedding models by coverage', () => {
    const { db, s } = seed();
    const ids = listSourceChunks(db, s.id).map(c => c.id);
    const ins = db.prepare(
      `INSERT INTO embeddings (owner_kind, owner_id, source_id, model, dim, text, text_hash, vec) VALUES ('chunk', ?, ?, ?, 1, 't', 'h', ?)`,
    );
    for (const id of ids) ins.run(id, s.id, 'nomic-embed-text', new Uint8Array(4));
    ins.run(ids[0], s.id, 'other', new Uint8Array(4));
    expect(chunkEmbeddingModels(db)).toEqual([
      { model: 'nomic-embed-text', chunks: ids.length },
      { model: 'other', chunks: 1 },
    ]);
  });
});

describe('embedder redirects', () => {
  it('refuses to follow a redirect away from the embedding server', async () => {
    let targetHits = 0;
    const target = http.createServer((_req, res) => { targetHits++; res.end('{}'); });
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;
    const bouncer = http.createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/embeddings` });
      res.end();
    });
    await new Promise<void>(r => bouncer.listen(0, '127.0.0.1', r));
    const port = (bouncer.address() as AddressInfo).port;
    try {
      const e = createOpenAICompatEmbedder(`http://127.0.0.1:${port}/v1`, 'm');
      await expect(e.embed(['hello'])).rejects.toThrow();
      expect(targetHits).toBe(0);
    } finally {
      bouncer.close();
      target.close();
    }
  });
});
