// Single source of truth for "wipe everything derived from a source, keep the
// source row + events". Used by:
//   - Startup recovery (mark stuck-in-processing sources as failed)
//   - Retry cleanup (clear partial LLM output before re-running)
//
// IMPORTANT: preserves the `sources` row, file_path, and the audit `events`
// table. By default ALSO preserves every concept that is not provably
// disposable: only an LLM-extracted concept (`origin = 'llm'`) with no
// user-owned data attached may be deleted (see DISPOSABLE_CONCEPT_SQL). Manual,
// promoted and unknown-origin concepts always survive. Only an explicit
// destructive rebuild (`preserveUserData: false`) touches user data.
//
// The whole wipe runs in one SAVEPOINT, so a failure part-way leaves the
// source exactly as it was.

import type { DatabaseSync } from '../core/infra/sqlite';
import { emitEvent } from '../core/events';
import { DISPOSABLE_EQUATION_WHERE, DISPOSABLE_MISCONCEPTION_WHERE, DISPOSABLE_RELATION_WHERE } from './repos/candidates';

export interface CleanupCounts {
  concept_candidates: number;
  relation_candidates: number;
  equation_candidates: number;
  misconception_candidates: number;
  semantic_chunks: number;
  prerequisite_suggestions: number; // derived from relation_candidates; safe to wipe
  concepts_deleted: number;     // disposable LLM concepts only; cascades their LLM tasks/misconceptions/mastery
  concepts_preserved: number;   // everything else (manual, promoted, unknown origin, or carrying user data)
}

export interface ClearOptions {
  /**
   * If true (default), only disposable concepts are deleted: origin 'llm'
   * with no user-owned data (see DISPOSABLE_CONCEPT_SQL).
   * If false, every concept for the source is dropped — destructive rebuild.
   */
  preserveUserData?: boolean;
}

// A concept is disposable only when ALL of these hold. Anything the user made
// or did that hangs off a concept keeps it alive, because deleting the concept
// would cascade that data away:
//   - origin is 'llm' (manual / promoted / NULL = unknown are never disposable)
//   - the user has never edited it (user_modified_at IS NULL): once a user
//     modifies generated content it is no longer disposable generated content
//   - no graded attempt (evidence_records) and no Ask history
//   - no SRS card (a `✓ Done` review or manual reschedule writes one)
//   - no user notes, tags, or curated constellations (where_reappears)
//   - no hub membership
//   - no PDF annotation pointing at it (live or soft-deleted, so undo works)
//   - no concept edge at all: edges carry no origin, so an LLM-written edge
//     cannot be told apart from a user-curated prerequisite. Ambiguity means
//     preserve.
const DISPOSABLE_CONCEPT_SQL = `
  SELECT c.id FROM concepts c
   WHERE c.source_id = ?
     AND c.origin = 'llm'
     AND c.user_modified_at IS NULL
     AND COALESCE(c.tags_json, '[]') IN ('', '[]')
     AND COALESCE(c.where_reappears, '[]') IN ('', '[]')
     AND NOT EXISTS (SELECT 1 FROM evidence_records r WHERE r.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM ask_history h WHERE h.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM concept_srs s WHERE s.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM concept_notes n WHERE n.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM star_hub_members m WHERE m.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM pdf_annotations a WHERE a.concept_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM concept_edges e WHERE e.from_id = c.id OR e.to_id = c.id)`;

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
  // SAVEPOINT (not BEGIN) so this is atomic on its own and still nests inside
  // a caller's transaction.
  db.exec('SAVEPOINT clear_derived');
  try {
    const counts = clearDerivedDataInner(db, sourceId, opts.preserveUserData ?? true);
    db.exec('RELEASE clear_derived');
    return counts;
  } catch (e) {
    db.exec('ROLLBACK TO clear_derived');
    db.exec('RELEASE clear_derived');
    throw e;
  }
}

function clearDerivedDataInner(db: DatabaseSync, sourceId: number, preserveUserData: boolean): CleanupCounts {

  // Concept candidates are parser output only (users promote/reject, never
  // author or edit them), so they are always regenerated.
  const concept_candidates       = countAndDelete(db, 'concept_candidates',       'source_id = ?', sourceId);
  // Relations, equations, misconceptions: only unedited parser output. Users
  // add and edit these (Candidate Review; equations also from a concept's
  // Overview), so these tables are not purely derived.
  const relation_candidates      = countAndDelete(db, 'relation_candidates',      DISPOSABLE_RELATION_WHERE, sourceId);
  const equation_candidates      = countAndDelete(db, 'equation_candidates',      DISPOSABLE_EQUATION_WHERE, sourceId);
  const misconception_candidates = countAndDelete(db, 'misconception_candidates', DISPOSABLE_MISCONCEPTION_WHERE, sourceId);
  const semantic_chunks          = countAndDelete(db, 'semantic_chunks',          'source_id = ?', sourceId);
  // Prerequisite suggestions are derived from relation_candidates. Wipe them
  // here so a re-extract recomputes them; accepted edges survive separately as
  // user-curated concept_edges rows on the preserved promoted concepts.
  const prerequisite_suggestions = countAndDelete(db, 'prerequisite_suggestions', 'source_id = ?', sourceId);
  // Embedding vectors are derived and rebuilt incrementally on demand.
  // Retrieval chunks (rag_chunks) and their vectors are NOT wiped here: they
  // are reconciled by chunk_key right after re-segmentation (syncSourceChunks),
  // so an unchanged document keeps its chunk ids and never re-embeds.
  countAndDelete(db, 'embeddings', `source_id = ? AND owner_kind <> 'chunk'`, sourceId);

  // Concepts: delete only the provably disposable ones (DISPOSABLE_CONCEPT_SQL).
  const allIdsRows = db
    .prepare(`SELECT id FROM concepts WHERE source_id = ?`)
    .all(sourceId) as Array<{ id: number | bigint }>;
  const allIds = allIdsRows.map(r => Number(r.id));

  let concepts_deleted = 0;
  let concepts_preserved = 0;

  if (allIds.length > 0) {
    if (preserveUserData) {
      const toDelete = (db.prepare(DISPOSABLE_CONCEPT_SQL).all(sourceId) as Array<{ id: number | bigint }>)
        .map(r => Number(r.id));
      concepts_preserved = allIds.length - toDelete.length;
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
