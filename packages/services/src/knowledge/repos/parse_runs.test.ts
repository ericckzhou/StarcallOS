import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { CONTRACT_VERSION, PARSER_VERSION } from '../../core/version';
import { createSource } from './sources';
import { createParseRun, listParseRunsBySource } from './parse_runs';

describe('parse_runs', () => {
  // Guards the INSERT column/placeholder/arg alignment — a mismatch (e.g. when
  // adding a version column) is a runtime SQLite error that typecheck can't catch.
  it('writes a run and stamps the current versions, including contract_version', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'book.pdf', file_path: 'book.pdf' });

    const run = createParseRun(db, {
      source_id: source.id,
      status: 'success',
      mode: 'deterministic',
      page_count: 742,
      block_count: 1200,
      candidate_count: 80,
      relation_count: 0,
      equation_count: 0,
      misconception_count: 0,
      duration_ms: 1234,
      llm_call_count: 0,
      llm_input_tokens: 0,
      llm_output_tokens: 0,
      diagnostics: { note: 'test' },
    });

    expect(run.contract_version).toBe(CONTRACT_VERSION);
    expect(run.parser_version).toBe(PARSER_VERSION);
    expect(run.status).toBe('success');
    expect(run.diagnostics).toEqual({ note: 'test' });

    const listed = listParseRunsBySource(db, source.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].contract_version).toBe(CONTRACT_VERSION);

    db.close();
  });
});
