// Append-only audit of every SOURCES_PROCESS invocation.
// One row per Process click — success, failure, or interruption.

import type { DatabaseSync } from '../../core/infra/sqlite';
import type { ExtractionMode } from '../../core/settings';
import { currentVersions } from '../../core/version';

export type ParseRunStatus = 'success' | 'failed' | 'interrupted';

export interface ParseRunInput {
  source_id: number;
  status: ParseRunStatus;
  error_msg?: string | null;
  mode: ExtractionMode;
  page_count: number;
  block_count: number;
  candidate_count: number;
  relation_count: number;
  equation_count: number;
  misconception_count: number;
  duration_ms: number;
  llm_call_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  diagnostics: Record<string, unknown>;
  completed_at?: string | null;
}

export interface ParseRun extends Omit<ParseRunInput, 'diagnostics'> {
  id: number;
  parser_version: string;
  grammar_version: string;
  layout_version: string;
  started_at: string;
  completed_at: string | null;
  diagnostics: Record<string, unknown>;
}

interface ParseRunRow {
  id: number | bigint;
  source_id: number | bigint;
  started_at: string;
  completed_at: string | null;
  status: string;
  error_msg: string | null;
  mode: string;
  parser_version: string;
  grammar_version: string;
  layout_version: string;
  page_count: number;
  block_count: number;
  candidate_count: number;
  relation_count: number;
  equation_count: number;
  misconception_count: number;
  duration_ms: number;
  llm_call_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  diagnostics_json: string;
}

function rowToParseRun(row: ParseRunRow): ParseRun {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    started_at: row.started_at,
    completed_at: row.completed_at,
    status: row.status as ParseRunStatus,
    error_msg: row.error_msg,
    mode: row.mode as ExtractionMode,
    parser_version: row.parser_version,
    grammar_version: row.grammar_version,
    layout_version: row.layout_version,
    page_count: row.page_count,
    block_count: row.block_count,
    candidate_count: row.candidate_count,
    relation_count: row.relation_count,
    equation_count: row.equation_count,
    misconception_count: row.misconception_count,
    duration_ms: row.duration_ms,
    llm_call_count: row.llm_call_count,
    llm_input_tokens: row.llm_input_tokens,
    llm_output_tokens: row.llm_output_tokens,
    diagnostics: JSON.parse(row.diagnostics_json) as Record<string, unknown>,
  };
}

export function createParseRun(db: DatabaseSync, input: ParseRunInput): ParseRun {
  const v = currentVersions();
  const result = db
    .prepare(
      `INSERT INTO parse_runs (
        source_id, completed_at, status, error_msg, mode,
        parser_version, grammar_version, layout_version,
        page_count, block_count, candidate_count, relation_count,
        equation_count, misconception_count, duration_ms,
        llm_call_count, llm_input_tokens, llm_output_tokens,
        diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_id,
      input.completed_at ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
      input.status,
      input.error_msg ?? null,
      input.mode,
      v.parser_version,
      v.grammar_version,
      v.layout_version,
      input.page_count,
      input.block_count,
      input.candidate_count,
      input.relation_count,
      input.equation_count,
      input.misconception_count,
      input.duration_ms,
      input.llm_call_count,
      input.llm_input_tokens,
      input.llm_output_tokens,
      JSON.stringify(input.diagnostics),
    );
  const row = db
    .prepare('SELECT * FROM parse_runs WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as ParseRunRow;
  return rowToParseRun(row);
}

export function listParseRunsBySource(db: DatabaseSync, sourceId: number, limit = 20): ParseRun[] {
  return (
    db
      .prepare(`SELECT * FROM parse_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(sourceId, limit) as unknown as ParseRunRow[]
  ).map(rowToParseRun);
}
