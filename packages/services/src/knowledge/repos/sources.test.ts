import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource, getLlmFilter, setLlmFilter } from './sources';

describe('source LLM topic filter persistence', () => {
  it('writes normalized keep terms to the terms column and legacy column', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'book.txt', file_path: 'book.txt' });

    setLlmFilter(db, source.id, ['gradient descent', 'backpropagation']);

    expect(getLlmFilter(db, source.id)).toEqual(['gradient descent', 'backpropagation']);
    const row = db
      .prepare('SELECT llm_filter_keep_terms_json, llm_filter_keep_ids_json FROM sources WHERE id = ?')
      .get(source.id) as { llm_filter_keep_terms_json: string; llm_filter_keep_ids_json: string };
    expect(JSON.parse(row.llm_filter_keep_terms_json)).toEqual(['gradient descent', 'backpropagation']);
    expect(JSON.parse(row.llm_filter_keep_ids_json)).toEqual(['gradient descent', 'backpropagation']);

    db.close();
  });

  it('backfills term saves from the legacy column', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'book.txt', file_path: 'book.txt' });
    db.prepare(
      `UPDATE sources
       SET llm_filter_keep_terms_json = NULL,
           llm_filter_keep_ids_json = ?
       WHERE id = ?`,
    ).run(JSON.stringify(['attention']), source.id);

    expect(getLlmFilter(db, source.id)).toEqual(['attention']);
    const row = db
      .prepare('SELECT llm_filter_keep_terms_json FROM sources WHERE id = ?')
      .get(source.id) as { llm_filter_keep_terms_json: string };
    expect(JSON.parse(row.llm_filter_keep_terms_json)).toEqual(['attention']);

    db.close();
  });

  it('wipes numeric legacy id saves on read', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'book.txt', file_path: 'book.txt' });
    db.prepare(
      `UPDATE sources
       SET llm_filter_keep_terms_json = NULL,
           llm_filter_keep_ids_json = ?
       WHERE id = ?`,
    ).run(JSON.stringify([1, 2, 3]), source.id);

    expect(getLlmFilter(db, source.id)).toBeNull();
    const row = db
      .prepare('SELECT llm_filter_keep_terms_json, llm_filter_keep_ids_json FROM sources WHERE id = ?')
      .get(source.id) as {
        llm_filter_keep_terms_json: string | null;
        llm_filter_keep_ids_json: string | null;
      };
    expect(row.llm_filter_keep_terms_json).toBeNull();
    expect(row.llm_filter_keep_ids_json).toBeNull();

    db.close();
  });
});
