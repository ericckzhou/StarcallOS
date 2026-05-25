import type { DatabaseSync } from '../../core/infra/sqlite';
import type { Source, SourceStatus } from '../../core/domain/types';

interface SourceRow {
  id: number | bigint;
  filename: string;
  title: string | null;
  author: string | null;
  file_path: string;
  page_count: number | null;
  status: string;
  error_msg: string | null;
  created_at: string;
}

function rowToSource(row: SourceRow): Source {
  return {
    id: Number(row.id),
    filename: row.filename,
    title: row.title,
    author: row.author,
    file_path: row.file_path,
    page_count: row.page_count,
    status: row.status as SourceStatus,
    error_msg: row.error_msg,
    created_at: row.created_at,
  };
}

export function createSource(
  db: DatabaseSync,
  input: { filename: string; file_path: string; title?: string; author?: string },
): Source {
  const result = db
    .prepare(
      `INSERT INTO sources (filename, file_path, title, author)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.filename, input.file_path, input.title ?? null, input.author ?? null);
  return getSourceById(db, Number(result.lastInsertRowid))!;
}

export function updateSourceStatus(
  db: DatabaseSync,
  id: number,
  status: SourceStatus,
  extra: { page_count?: number; error_msg?: string } = {},
): void {
  db.prepare(
    `UPDATE sources SET status = ?, page_count = COALESCE(?, page_count),
     error_msg = ? WHERE id = ?`,
  ).run(status, extra.page_count ?? null, extra.error_msg ?? null, id);
}

export function getSourceById(db: DatabaseSync, id: number): Source | null {
  const row = db
    .prepare('SELECT * FROM sources WHERE id = ?')
    .get(id) as SourceRow | undefined;
  return row != null ? rowToSource(row) : null;
}

export function listSources(db: DatabaseSync): Source[] {
  return (
    db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all() as unknown as SourceRow[]
  ).map(rowToSource);
}

export function deleteSource(db: DatabaseSync, id: number): void {
  db.prepare('PRAGMA foreign_keys = ON').run();
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
}

// Topic anchors are derived deterministically at parse time and stored per
// source so future re-extractions (or other passes) can reuse them.
export function setTopicAnchors(db: DatabaseSync, sourceId: number, anchors: string[]): void {
  db.prepare('UPDATE sources SET topic_anchors_json = ? WHERE id = ?')
    .run(JSON.stringify(anchors), sourceId);
}

export function getTopicAnchors(db: DatabaseSync, sourceId: number): string[] {
  const row = db
    .prepare('SELECT topic_anchors_json FROM sources WHERE id = ?')
    .get(sourceId) as { topic_anchors_json?: string } | undefined;
  if (!row?.topic_anchors_json) return [];
  try {
    return JSON.parse(row.topic_anchors_json) as string[];
  } catch {
    return [];
  }
}

// Persisted LLM topic-fit filter: list of normalized candidate TERMS the LLM
// marked keep:true. Terms are stable across re-extracts (where row IDs churn).
// Legacy saves contained numeric IDs and are silently wiped on read so the user
// recovers cleanly instead of getting stuck with orphaned filters.
export function setLlmFilter(db: DatabaseSync, sourceId: number, keepTerms: string[] | null): void {
  db.prepare('UPDATE sources SET llm_filter_keep_ids_json = ? WHERE id = ?')
    .run(keepTerms === null ? null : JSON.stringify(keepTerms), sourceId);
}

export function getLlmFilter(db: DatabaseSync, sourceId: number): string[] | null {
  const row = db
    .prepare('SELECT llm_filter_keep_ids_json FROM sources WHERE id = ?')
    .get(sourceId) as { llm_filter_keep_ids_json?: string | null } | undefined;
  if (!row?.llm_filter_keep_ids_json) return null;
  try {
    const arr = JSON.parse(row.llm_filter_keep_ids_json) as unknown;
    if (!Array.isArray(arr)) return null;
    const strings = arr.filter((v): v is string => typeof v === 'string');
    // If nothing parses as a string, the stored data is the legacy numeric
    // format. Wipe it in-place so future loads are clean.
    if (strings.length === 0) {
      db.prepare('UPDATE sources SET llm_filter_keep_ids_json = NULL WHERE id = ?').run(sourceId);
      return null;
    }
    return strings;
  } catch {
    return null;
  }
}
