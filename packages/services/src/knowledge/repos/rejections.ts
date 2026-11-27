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

// A concept's stable identity: its source plus its slug. Database ids are not
// stable (a concept deleted by re-extract and promoted again gets a new id);
// the slug never changes (rename keeps it; promotion is idempotent on
// (source_id, slug)).
export interface ConceptIdentity { source_id: number; slug: string }

export function conceptStableKey(c: ConceptIdentity): string {
  return `${Number(c.source_id)}:${c.slug}`;
}

export function prerequisiteRejectionKey(from: ConceptIdentity, to: ConceptIdentity, edgeType: string): string {
  return `${conceptStableKey(from)}>${conceptStableKey(to)}|${edgeType}`;
}

// Maps current concept ids to their stable identity, for checking freshly
// computed suggestions (which carry ids) against rejection keys.
export function conceptIdentityResolver(db: DatabaseSync): (id: number) => ConceptIdentity | null {
  const byId = new Map((db.prepare('SELECT id, source_id, slug FROM concepts').all() as Array<{ id: number; source_id: number; slug: string }>)
    .map(c => [Number(c.id), { source_id: Number(c.source_id), slug: c.slug }]));
  return id => byId.get(id) ?? null;
}

// True when the suggestion from -> to (ids) matches a rejected identity.
export function isPrerequisiteRejected(
  rejected: Set<string>,
  identityOf: (id: number) => ConceptIdentity | null,
  fromId: number,
  toId: number,
  edgeType: string,
): boolean {
  const from = identityOf(fromId);
  const to = identityOf(toId);
  return !!from && !!to && rejected.has(prerequisiteRejectionKey(from, to, edgeType));
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
  // One record per (source, kind, identity). If the identity is already
  // rejected, newly removed rows are appended to its snapshot so undo still
  // restores every row that any rejection removed.
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));
  const existing = db.prepare(
    'SELECT id, payload_json FROM candidate_rejections WHERE source_id = ? AND kind = ? AND identity_key = ?',
  ).get(r.sourceId, r.kind, r.key) as { id: number; payload_json: string } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO candidate_rejections (source_id, kind, identity_key, label, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.sourceId, r.kind, r.key, r.label, json(r.payload));
    return;
  }
  const newRows = (r.payload as { rows?: unknown[] }).rows;
  if (!Array.isArray(newRows) || newRows.length === 0) return;
  const prev = JSON.parse(existing.payload_json) as { rows?: unknown[] };
  db.prepare('UPDATE candidate_rejections SET payload_json = ? WHERE id = ?')
    .run(json({ ...prev, rows: [...(prev.rows ?? []), ...newRows] }), Number(existing.id));
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

// A rejection applies to an IDENTITY, not one row: every parser row in the
// source carrying that identity is snapshotted and removed together (and all
// restored together on undo). Otherwise rejecting one of two identical parser
// outputs would leave the other visible while the record suppresses both.
function rejectRows(
  db: DatabaseSync,
  r: { sourceId: number; kind: Exclude<RejectionKind, 'prerequisite'>; key: string; label: string; rows: Array<Record<string, unknown>> },
): void {
  const table = TABLE_BY_KIND[r.kind];
  recordRejection(db, { sourceId: r.sourceId, kind: r.kind, key: r.key, label: r.label, payload: { rows: r.rows } });
  const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  for (const row of r.rows) del.run(Number(row.id));
}

// Concept candidates are always parser output; identity = normalized term.
export function rejectConceptCandidate(db: DatabaseSync, candidateId: number): boolean {
  const row = db.prepare('SELECT * FROM concept_candidates WHERE id = ?').get(candidateId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const sourceId = Number(row.source_id);
  inSavepoint(db, 'reject_concept', () => {
    const rows = db.prepare('SELECT * FROM concept_candidates WHERE source_id = ? AND normalized = ? ORDER BY id')
      .all(sourceId, row.normalized as string) as Array<Record<string, unknown>>;
    rejectRows(db, { sourceId, kind: 'concept', key: String(row.normalized), label: String(row.term), rows });
    emitEvent(db, 'concept_candidate.rejected', { candidateId, term: row.term },
      { entityType: 'source', entityId: sourceId });
  });
  return true;
}

// Relation / misconception: remembered only when the row carries the parser's
// identity (source_key: a parser row, edited or not), and then every row with
// that source_key goes. Rows without one (user-created, unknown-origin
// legacy) are deleted alone and never matched to the identity, even when
// their content is identical. Returns whether a rejection was recorded.
function rejectKeyedCandidate(
  db: DatabaseSync,
  kind: 'relation' | 'misconception',
  id: number,
  label: (row: Record<string, unknown>) => string,
): boolean {
  const table = TABLE_BY_KIND[kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  const sourceId = Number(row.source_id);
  const key = row.source_key == null ? null : String(row.source_key);
  return inSavepoint(db, `reject_${kind}`, () => {
    if (!key) {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return false;
    }
    const rows = db.prepare(`SELECT * FROM ${table} WHERE source_id = ? AND source_key = ? ORDER BY id`)
      .all(sourceId, key) as Array<Record<string, unknown>>;
    rejectRows(db, { sourceId, kind, key, label: label(row), rows });
    return true;
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
    `SELECT s.source_id, s.edge_type, a.name AS from_name, b.name AS to_name,
            a.source_id AS from_source, a.slug AS from_slug, b.source_id AS to_source, b.slug AS to_slug
       FROM prerequisite_suggestions s
       JOIN concepts a ON a.id = s.from_id
       JOIN concepts b ON b.id = s.to_id
      WHERE s.id = ?`,
  ).get(suggestionId) as {
    source_id: number; edge_type: string; from_name: string; to_name: string;
    from_source: number; from_slug: string; to_source: number; to_slug: string;
  } | undefined;
  if (!row) return false;
  const from: ConceptIdentity = { source_id: Number(row.from_source), slug: row.from_slug };
  const to: ConceptIdentity = { source_id: Number(row.to_source), slug: row.to_slug };
  inSavepoint(db, 'reject_prereq', () => {
    recordRejection(db, {
      sourceId: Number(row.source_id), kind: 'prerequisite',
      key: prerequisiteRejectionKey(from, to, row.edge_type),
      label: `${row.from_name} → ${row.to_name}`,
      payload: { from, to, edge_type: row.edge_type },
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
      // Resolve the endpoints by stable identity to whatever ids they have
      // NOW (the concepts may have been recreated since the rejection).
      const from = payload.from as ConceptIdentity;
      const to = payload.to as ConceptIdentity;
      db.prepare(
        `UPDATE prerequisite_suggestions SET status = 'pending'
          WHERE source_id = ? AND edge_type = ? AND status = 'dismissed'
            AND from_id IN (SELECT id FROM concepts WHERE source_id = ? AND slug = ?)
            AND to_id   IN (SELECT id FROM concepts WHERE source_id = ? AND slug = ?)`,
      ).run(Number(rec.source_id), String(payload.edge_type),
        Number(from.source_id), from.slug, Number(to.source_id), to.slug);
    } else {
      // Every row the rejection removed comes back.
      const rows = Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [payload];
      for (const row of rows) restoreRow(db, TABLE_BY_KIND[rec.kind], { ...row, source_id: Number(rec.source_id) });
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
