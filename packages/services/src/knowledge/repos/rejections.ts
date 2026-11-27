// Source-scoped rejection memory (migration 0041). Rejecting a candidate is a
// user decision: it must survive re-extract, and it must stay undoable.
//
// - reject*: record the rejection and remove/dismiss the row in ONE savepoint.
//   Only rows with a parser identity get a record (a concept candidate's
//   normalized term, a relation/misconception row's source_key, a prerequisite
//   suggestion's from>to|edge_type). User-created and unknown-origin legacy
//   rows are simply deleted: there is no parser output to suppress, and a
//   guessed identity must never suppress anything.
// - Re-extract (persistCandidateExtraction, the suggestion compute paths)
//   skips parser output whose identity has a record.
// - undoRejection / clearRejectionsForSource: restore the snapshotted row and
//   delete the record, in one savepoint.

import type { DatabaseSync } from '../../core/infra/sqlite';
import { emitEvent } from '../../core/events';

export type RejectionKind = 'concept' | 'relation' | 'misconception' | 'prerequisite';

export interface CandidateRejection {
  id: number;
  source_id: number;
  kind: RejectionKind;
  identity_key: string;
  label: string;
  created_at: string;
}

const TABLE_BY_KIND: Record<Exclude<RejectionKind, 'prerequisite'>, string> = {
  concept: 'concept_candidates',
  relation: 'relation_candidates',
  misconception: 'misconception_candidates',
};

export function prerequisiteRejectionKey(fromId: number, toId: number, edgeType: string): string {
  return `${fromId}>${toId}|${edgeType}`;
}

function inSavepoint<T>(db: DatabaseSync, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw e;
  }
}

function recordRejection(
  db: DatabaseSync,
  r: { sourceId: number; kind: RejectionKind; key: string; label: string; payload: unknown },
): void {
  // Two identical parser outputs share one identity; rejecting either
  // suppresses both, and the first snapshot is kept for undo.
  db.prepare(
    `INSERT OR IGNORE INTO candidate_rejections (source_id, kind, identity_key, label, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(r.sourceId, r.kind, r.key, r.label, JSON.stringify(r.payload, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

// Identities rejected for one source and kind, for re-extract to skip.
export function rejectedKeys(db: DatabaseSync, sourceId: number, kind: RejectionKind): Set<string> {
  return new Set((db.prepare(
    'SELECT identity_key FROM candidate_rejections WHERE source_id = ? AND kind = ?',
  ).all(sourceId, kind) as Array<{ identity_key: string }>).map(r => r.identity_key));
}

export function listRejections(db: DatabaseSync, sourceId: number): CandidateRejection[] {
  return (db.prepare(
    `SELECT id, source_id, kind, identity_key, label, created_at FROM candidate_rejections
      WHERE source_id = ? ORDER BY created_at DESC, id DESC`,
  ).all(sourceId) as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id), source_id: Number(r.source_id), kind: r.kind as RejectionKind,
    identity_key: String(r.identity_key), label: String(r.label), created_at: String(r.created_at),
  }));
}

// ─── reject ───────────────────────────────────────────────────────────────────

// Concept candidates are always parser output; identity = normalized term.
export function rejectConceptCandidate(db: DatabaseSync, candidateId: number): boolean {
  const row = db.prepare('SELECT * FROM concept_candidates WHERE id = ?').get(candidateId) as Record<string, unknown> | undefined;
  if (!row) return false;
  inSavepoint(db, 'reject_concept', () => {
    recordRejection(db, {
      sourceId: Number(row.source_id), kind: 'concept', key: String(row.normalized), label: String(row.term), payload: row,
    });
    emitEvent(db, 'concept_candidate.rejected', { candidateId, term: row.term },
      { entityType: 'source', entityId: Number(row.source_id) });
    db.prepare('DELETE FROM concept_candidates WHERE id = ?').run(candidateId);
  });
  return true;
}

// Relation / misconception: remembered only when the row carries the parser's
// identity (source_key: a parser row, edited or not). Returns whether a
// rejection was recorded.
function rejectKeyedCandidate(
  db: DatabaseSync,
  kind: 'relation' | 'misconception',
  id: number,
  label: (row: Record<string, unknown>) => string,
): boolean {
  const table = TABLE_BY_KIND[kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  const key = row.source_key == null ? null : String(row.source_key);
  return inSavepoint(db, `reject_${kind}`, () => {
    if (key) recordRejection(db, { sourceId: Number(row.source_id), kind, key, label: label(row), payload: row });
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return key != null;
  });
}

export function rejectRelationCandidate(db: DatabaseSync, id: number): boolean {
  return rejectKeyedCandidate(db, 'relation', id, r => `${r.from_term} ${r.relation_kind} ${r.to_term}`);
}

export function rejectMisconceptionCandidate(db: DatabaseSync, id: number): boolean {
  return rejectKeyedCandidate(db, 'misconception', id, r => String(r.quote));
}

// Prerequisite suggestions keep their row as 'dismissed' (the existing UI
// contract); the record makes the dismissal survive the re-extract wipe.
export function rejectPrerequisiteSuggestionRecorded(db: DatabaseSync, suggestionId: number): boolean {
  const row = db.prepare(
    `SELECT s.source_id, s.from_id, s.to_id, s.edge_type, a.name AS from_name, b.name AS to_name
       FROM prerequisite_suggestions s
       JOIN concepts a ON a.id = s.from_id
       JOIN concepts b ON b.id = s.to_id
      WHERE s.id = ?`,
  ).get(suggestionId) as { source_id: number; from_id: number; to_id: number; edge_type: string; from_name: string; to_name: string } | undefined;
  if (!row) return false;
  inSavepoint(db, 'reject_prereq', () => {
    recordRejection(db, {
      sourceId: Number(row.source_id), kind: 'prerequisite',
      key: prerequisiteRejectionKey(Number(row.from_id), Number(row.to_id), row.edge_type),
      label: `${row.from_name} → ${row.to_name}`,
      payload: { from_id: Number(row.from_id), to_id: Number(row.to_id), edge_type: row.edge_type },
    });
    db.prepare(`UPDATE prerequisite_suggestions SET status = 'dismissed' WHERE id = ?`).run(suggestionId);
  });
  return true;
}

// ─── undo ─────────────────────────────────────────────────────────────────────

// Re-insert a snapshotted row with its original columns (origin, source_key,
// user_modified_at included). Only columns that exist on the table are used,
// so a stale or tampered payload cannot inject SQL or unknown columns.
function restoreRow(db: DatabaseSync, table: string, payload: Record<string, unknown>): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
  const cols = Object.keys(payload).filter(k => k !== 'id' && columns.has(k));
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => payload[c] as string | number | null));
}

// Undo one rejection: restore the row (or un-dismiss the suggestion) and
// delete the record. Returns false when the record no longer exists.
export function undoRejection(db: DatabaseSync, rejectionId: number): boolean {
  const rec = db.prepare('SELECT * FROM candidate_rejections WHERE id = ?').get(rejectionId) as
    { id: number; source_id: number; kind: RejectionKind; identity_key: string; payload_json: string } | undefined;
  if (!rec) return false;
  const payload = JSON.parse(rec.payload_json) as Record<string, unknown>;
  inSavepoint(db, 'undo_rejection', () => {
    if (rec.kind === 'prerequisite') {
      db.prepare(
        `UPDATE prerequisite_suggestions SET status = 'pending'
          WHERE source_id = ? AND from_id = ? AND to_id = ? AND edge_type = ? AND status = 'dismissed'`,
      ).run(Number(rec.source_id), Number(payload.from_id), Number(payload.to_id), String(payload.edge_type));
    } else {
      restoreRow(db, TABLE_BY_KIND[rec.kind], { ...payload, source_id: Number(rec.source_id) });
    }
    db.prepare('DELETE FROM candidate_rejections WHERE id = ?').run(rejectionId);
    emitEvent(db, 'candidate.rejection_undone', { rejectionId, kind: rec.kind, identity: rec.identity_key },
      { entityType: 'source', entityId: Number(rec.source_id) });
  });
  return true;
}

export function clearRejectionsForSource(db: DatabaseSync, sourceId: number): number {
  const ids = (db.prepare('SELECT id FROM candidate_rejections WHERE source_id = ?').all(sourceId) as Array<{ id: number }>)
    .map(r => Number(r.id));
  return inSavepoint(db, 'clear_rejections', () => ids.filter(id => undoRejection(db, id)).length);
}
