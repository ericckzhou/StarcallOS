// Test fixture: a real database file seeded through the services layer, then
// reopened READ-ONLY, so any tool that tried to write would fail the test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkBlocks,
  createConcept,
  createEdge,
  createPdfAnnotation,
  createSource,
  indexSourceChunkEmbeddings,
  normalize,
  openDb,
  openDbReadOnly,
  syncSourceChunks,
  createNote,
  type BlockHint,
  type Embedder,
  type SegmentedBlock,
} from '@starcall/services';

let order = 0;
function blk(text: string, page: number, hint: BlockHint = 'body'): SegmentedBlock {
  return {
    text, page, readingOrder: order++, hint, hintConfidence: 2,
    signals: { fontSizeRatio: 1, yGapAbove: 0, xColumnIndex: 0, isIsolatedLine: false, isAllCaps: false, isBold: false },
  };
}

const AXES = [/entropy|uncertain|surprise/i, /gradient|descent|slope/i, /mitochond|atp/i];
export function topicEmbedder(model = 'topic'): Embedder & { calls: number } {
  const e = {
    model, calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map(t => normalize(Float32Array.from([...AXES.map(re => (re.test(t) ? 1 : 0)), 0.05])));
    },
  };
  return e;
}

export interface Fixture {
  dir: string;
  dbPath: string;
  ids: { ml: number; bio: number; entropy: number; gradient: number; highlight: number; stickyNote: number };
  cleanup(): void;
}

export async function seedFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-mcp-'));
  const dbPath = path.join(dir, 'stellaria.db');
  // A settings.json with fake keys next to the DB: the server must never read it.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    provider: 'anthropic', anthropicApiKey: 'sk-ant-FAKE-SECRET-123', groqApiKey: 'gsk_FAKE_SECRET_456',
  }));
  const db = openDb(dbPath);
  const ml = createSource(db, { filename: 'ml.pdf', file_path: 'C:/Users/someone/ml.pdf', title: 'Machine Learning Notes' });
  const bio = createSource(db, { filename: 'bio.pdf', file_path: 'C:/Users/someone/bio.pdf', title: 'Cell Biology' });
  order = 0;
  syncSourceChunks(db, ml.id, chunkBlocks([
    blk('Entropy', 3, 'heading'),
    blk('Entropy measures the uncertainty of a random variable: the expected surprise of its outcomes.', 3),
    blk('Gradient descent', 4, 'heading'),
    blk('Gradient descent repeatedly steps against the slope of the loss to find a minimum.', 4),
  ]).chunks);
  order = 0;
  syncSourceChunks(db, bio.id, chunkBlocks([
    blk('Mitochondria', 7, 'heading'),
    blk('The mitochondrion produces ATP through oxidative phosphorylation across its inner membrane.', 7),
  ]).chunks);
  const emb = topicEmbedder();
  await indexSourceChunkEmbeddings(db, emb, ml.id);
  await indexSourceChunkEmbeddings(db, emb, bio.id);

  const base = { importance: 'core' as const, why_exists: '', what_breaks: '', where_reappears: [] as string[],
    chunk_ids: [] as number[], section_path: [] as string[], exam_value: 0, misconception_risk: 0, centrality_score: 0 };
  const entropy = createConcept(db, { ...base, source_id: ml.id, name: 'Entropy', slug: 'entropy',
    definition_text: 'The expected surprise of a random variable.', why_exists: 'To quantify uncertainty.' }, 'promoted');
  const gradient = createConcept(db, { ...base, source_id: ml.id, name: 'Gradient descent', slug: 'gradient-descent',
    definition_text: 'Iterative minimisation by stepping against the gradient.' }, 'promoted');
  // from = prerequisite, to = dependent: entropy is learned before gradient descent.
  createEdge(db, entropy.id, gradient.id, 'requires');
  createNote(db, entropy.id, { heading: 'My take', body: 'Think of entropy as average surprise.' });

  const rect = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }];
  const highlight = createPdfAnnotation(db, {
    sourceId: bio.id, scope: 'source', type: 'highlight', createdFrom: 'manual_selection', page: 7,
    selectedText: 'produces ATP through oxidative phosphorylation', label: 'key mechanism', noteBody: 'exam!', rects: rect,
  });
  const sticky = createPdfAnnotation(db, {
    sourceId: bio.id, type: 'note', createdFrom: 'manual_note', page: 7, noteBody: 'sticky ATP note', rects: rect,
  });
  db.close();
  return {
    dir, dbPath,
    ids: { ml: ml.id, bio: bio.id, entropy: entropy.id, gradient: gradient.id, highlight: highlight.id, stickyNote: sticky.id },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function openFixtureReadOnly(f: Fixture) {
  return openDbReadOnly(f.dbPath);
}
