// Single source of truth for "wipe everything derived from a source, keep the
// source row + events". Used by:
//   - Startup recovery (mark stuck-in-processing sources as failed)
//   - Retry cleanup (clear partial LLM output before re-running)
//
// IMPORTANT: preserves the `sources` row, file_path, and the audit `events`
// table. By default ALSO preserves concepts the user has actually studied
// (any row in `evidence_records` is considered "study history"). Only an
// explicit destructive rebuild touches user data.

import type { DatabaseSync } from '../core/infra/sqlite';
import { emitEvent } from '../core/events';

export interface CleanupCounts {
  concept_candidates: number;
  relation_candidates: number;
  equation_candidates: number;
  misconception_candidates: number;
  semantic_chunks: number;
  prerequisite_suggestions: number; // derived from relation_candidates; safe to wipe
  concepts_deleted: number;     // cascade-deletes concept_edges, evidence_tasks, misconceptions, mastery, evidence_records
  concepts_preserved: number;   // concepts with study history (evidence_records present) — left untouched
}

export interface ClearOptions {
  /**
   * If true (default), concepts with any row in evidence_records are
   * preserved along with their tasks/mastery/edges/misconceptions.
   * If false, every concept for the source is dropped — destructive rebuild.
   */
  preserveUserData?: boolean;
}

type SqlParam = string | number | bigint | null;

function countAndDelete(db: DatabaseSync, table: string, where: string, ...params: SqlParam[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)
    .get(...params) as { c: number };
  db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
  return row.c;
}

/**
 * Wipe derived artifacts for one source. Always safe for the candidate tables
 * and semantic_chunks. For `concepts`, defaults to preserving any concept
 * that has user study history.
 */
export function clearDerivedDataForSource(
  db: DatabaseSync,
  sourceId: number,
  opts: ClearOptions = {},
): CleanupCounts {
  const preserveUserData = opts.preserveUserData ?? true;

  // Always-safe deletes (no user data lives in these tables)
  const concept_candidates       = countAndDelete(db, 'concept_candidates',       'source_id = ?', sourceId);
  const relation_candidates      = countAndDelete(db, 'relation_candidates',      'source_id = ?', sourceId);
  const equation_candidates      = countAndDelete(db, 'equation_candidates',      'source_id = ?', sourceId);
  const misconception_candidates = countAndDelete(db, 'misconception_candidates', 'source_id = ?', sourceId);
  const semantic_chunks          = countAndDelete(db, 'semantic_chunks',          'source_id = ?', sourceId);
  // Prerequisite suggestions are derived from relation_candidates. Wipe them
  // here so a re-extract recomputes them; accepted edges survive separately as
  // user-curated concept_edges rows on the preserved promoted concepts.
  const prerequisite_suggestions = countAndDelete(db, 'prerequisite_suggestions', 'source_id = ?', sourceId);

  // Concepts: split by whether the user has studied them.
  // "Studied" = at least one row in evidence_records for that concept_id.
  const allIdsRows = db
    .prepare(`SELECT id FROM concepts WHERE source_id = ?`)
    .all(sourceId) as Array<{ id: number | bigint }>;
  const allIds = allIdsRows.map(r => Number(r.id));

  let concepts_deleted = 0;
  let concepts_preserved = 0;

  if (allIds.length > 0) {
    if (preserveUserData) {
      // Preserve a concept if EITHER it has study history OR it was promoted
      // from a deterministic candidate (= has a non-empty evidence_json, set
      // at promotion time). Re-extracting shouldn't silently wipe the things
      // the user explicitly said "I want to learn this."
      const studiedRows = db
        .prepare(
          `SELECT DISTINCT concept_id FROM evidence_records
           WHERE concept_id IN (${allIds.map(() => '?').join(',')})`,
        )
        .all(...allIds) as Array<{ concept_id: number | bigint }>;
      const studied = new Set(studiedRows.map(r => Number(r.concept_id)));

      const promotedRows = db
        .prepare(
          `SELECT id FROM concepts
           WHERE id IN (${allIds.map(() => '?').join(',')})
             AND evidence_json IS NOT NULL
             AND evidence_json != '[]'
             AND evidence_json != ''`,
        )
        .all(...allIds) as Array<{ id: number | bigint }>;
      const promoted = new Set(promotedRows.map(r => Number(r.id)));

      const keep = new Set<number>([...studied, ...promoted]);
      const toDelete = allIds.filter(id => !keep.has(id));
      concepts_preserved = keep.size;
      if (toDelete.length > 0) {
        db.prepare(
          `DELETE FROM concepts WHERE id IN (${toDelete.map(() => '?').join(',')})`,
        ).run(...toDelete);
        concepts_deleted = toDelete.length;
      }
    } else {
      db.prepare(`DELETE FROM concepts WHERE source_id = ?`).run(sourceId);
      concepts_deleted = allIds.length;
    }
  }

  return {
    concept_candidates,
    relation_candidates,
    equation_candidates,
    misconception_candidates,
    semantic_chunks,
    prerequisite_suggestions,
    concepts_deleted,
    concepts_preserved,
  };
}

/**
 * Returns true iff at least one concept for this source has a row in
 * evidence_records. Used by the UI to gate destructive rebuilds behind
 * an explicit confirmation.
 */
export function sourceHasStudyHistory(db: DatabaseSync, sourceId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM evidence_records er
       JOIN concepts c ON c.id = er.concept_id
       WHERE c.source_id = ? LIMIT 1`,
    )
    .get(sourceId) as { 1?: number } | undefined;
  return row != null;
}

/**
 * Scan the sources table on app boot. Anything stuck in 'processing' was
 * killed mid-run. Mark it failed with a recoverable error and emit an event.
 * Returns the IDs that were recovered so the caller can log them.
 */
export function recoverInterruptedSources(db: DatabaseSync): number[] {
  const rows = db
    .prepare(`SELECT id FROM sources WHERE status = 'processing'`)
    .all() as Array<{ id: number | bigint }>;
  const recovered: number[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    db.prepare(
      `UPDATE sources
       SET status = 'failed',
           error_msg = ?
       WHERE id = ?`,
    ).run(
      'Processing was interrupted (likely app restart or crash). Retry to rebuild derived data.',
      id,
    );
    emitEvent(
      db,
      'source.processing_interrupted',
      { sourceId: id, reason: 'startup_scan' },
      { entityType: 'source', entityId: id },
    );
    recovered.push(id);
  }
  return recovered;
}
