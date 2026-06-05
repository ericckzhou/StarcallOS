// Prerequisite suggestion engine (migration 0028).
//
// Turns the deterministic `requires`/`enables` relation_candidates the
// candidate-first parser already extracts into DIRECTED prerequisite-edge
// SUGGESTIONS between promoted concepts. Nothing is written to the user-curated
// `concept_edges` table until the user explicitly accepts a suggestion — this
// preserves the invariant that edges are user-curated and a parser/LLM never
// silently writes them.
//
// Direction (the easy thing to get wrong — pinned by a dedicated test):
//   concept_edges convention: from_id = PREREQUISITE, to_id = DEPENDENT.
//   relation "A requires B"  (from=A,to=B) => B is the prerequisite of A
//                                          => edge from_id=B, to_id=A  (FLIP).
//   relation "A enables B"   (from=A,to=B) => A is the prerequisite of B
//                                          => edge from_id=A, to_id=B  (no flip).

import type { DatabaseSync } from '../core/infra/sqlite';
import { createEdge } from './repos/concepts';
import { emitEvent } from '../core/events';

export type SuggestionEdgeType = 'requires' | 'enables';
export type SuggestionBasis = 'deterministic' | 'llm';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface PrerequisiteSuggestion {
  id: number;
  source_id: number;
  from_id: number; // prerequisite
  to_id: number; // dependent
  from_name: string;
  to_name: string;
  edge_type: SuggestionEdgeType;
  basis: SuggestionBasis;
  confidence: number;
  reason: string;
  status: SuggestionStatus;
  created_at: string;
}

interface SuggestionRow {
  id: number | bigint;
  source_id: number | bigint;
  from_id: number | bigint;
  to_id: number | bigint;
  from_name: string;
  to_name: string;
  edge_type: string;
  basis: string;
  confidence: number;
  reason: string;
  status: string;
  created_at: string;
}

function rowToSuggestion(r: SuggestionRow): PrerequisiteSuggestion {
  return {
    id: Number(r.id),
    source_id: Number(r.source_id),
    from_id: Number(r.from_id),
    to_id: Number(r.to_id),
    from_name: r.from_name,
    to_name: r.to_name,
    edge_type: r.edge_type as SuggestionEdgeType,
    basis: r.basis as SuggestionBasis,
    confidence: r.confidence,
    reason: r.reason,
    status: r.status as SuggestionStatus,
    created_at: r.created_at,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// One directed prerequisite edge derived from a relation, already oriented so
// from_id is the prerequisite. `reason` carries the source quote/snippet.
export interface DerivedEdge {
  fromId: number;
  toId: number;
  edgeType: SuggestionEdgeType;
  reason: string;
}

// Pure mapping from a relation candidate to a directed prerequisite edge.
// Exported so the direction contract is unit-testable in isolation. Returns
// null when the kind is not dependency-bearing, an endpoint doesn't resolve to
// a promoted concept, or it would be a self-edge.
export function deriveEdgeFromRelation(
  relation: { from: string; to: string; kind: string; quote?: string },
  conceptIdByName: Map<string, number>,
): DerivedEdge | null {
  if (relation.kind !== 'requires' && relation.kind !== 'enables') return null;
  const fromConcept = conceptIdByName.get(normalizeName(relation.from));
  const toConcept = conceptIdByName.get(normalizeName(relation.to));
  if (fromConcept == null || toConcept == null) return null;

  // Orient so fromId = prerequisite, toId = dependent.
  let prereq: number;
  let dependent: number;
  if (relation.kind === 'requires') {
    // "from requires to" => `to` is the prerequisite of `from`.
    prereq = toConcept;
    dependent = fromConcept;
  } else {
    // "from enables to" => `from` is the prerequisite of `to`.
    prereq = fromConcept;
    dependent = toConcept;
  }
  if (prereq === dependent) return null; // no self-edges
  return {
    fromId: prereq,
    toId: dependent,
    edgeType: relation.kind,
    reason: (relation.quote ?? '').trim(),
  };
}

// True if a concept_edges row already exists for this directed pair + type, in
// which case there is nothing to suggest (the user already has the edge).
function edgeExists(db: DatabaseSync, fromId: number, toId: number, edgeType: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM concept_edges WHERE from_id = ? AND to_id = ? AND edge_type = ? LIMIT 1')
    .get(fromId, toId, edgeType) as { 1?: number } | undefined;
  return row != null;
}

export interface ComputeSuggestionsResult {
  created: number;
  skippedExistingEdge: number;
  skippedUnresolved: number;
}

// Recompute deterministic prerequisite suggestions for one source from its
// relation_candidates. Idempotent on the (from,to,type) pair: a row that is
// already accepted/dismissed is left as-is (never resurrected); a new pending
// row is inserted only for a pair that has neither a suggestion nor a real
// edge yet.
export function computeDeterministicSuggestions(
  db: DatabaseSync,
  sourceId: number,
): ComputeSuggestionsResult {
  const concepts = db
    .prepare('SELECT id, name FROM concepts WHERE source_id = ?')
    .all(sourceId) as Array<{ id: number | bigint; name: string }>;
  const conceptIdByName = new Map<string, number>();
  for (const c of concepts) conceptIdByName.set(normalizeName(c.name), Number(c.id));

  const relations = db
    .prepare('SELECT from_term, to_term, relation_kind, quote FROM relation_candidates WHERE source_id = ?')
    .all(sourceId) as Array<{ from_term: string; to_term: string; relation_kind: string; quote: string }>;

  let created = 0;
  let skippedExistingEdge = 0;
  let skippedUnresolved = 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO prerequisite_suggestions
       (source_id, from_id, to_id, edge_type, basis, confidence, reason, status)
     VALUES (?, ?, ?, ?, 'deterministic', ?, ?, 'pending')`,
  );

  for (const r of relations) {
    const derived = deriveEdgeFromRelation(
      { from: r.from_term, to: r.to_term, kind: r.relation_kind, quote: r.quote },
      conceptIdByName,
    );
    if (!derived) { skippedUnresolved += 1; continue; }
    if (edgeExists(db, derived.fromId, derived.toId, derived.edgeType)) {
      skippedExistingEdge += 1;
      continue;
    }
    const res = insert.run(
      sourceId,
      derived.fromId,
      derived.toId,
      derived.edgeType,
      0.6, // deterministic relation match: moderate, fixed confidence
      derived.reason,
    );
    if (Number(res.changes) > 0) created += 1;
  }

  return { created, skippedExistingEdge, skippedUnresolved };
}

const SUGGESTION_SELECT = `
  SELECT s.*, cf.name AS from_name, ct.name AS to_name
    FROM prerequisite_suggestions s
    JOIN concepts cf ON cf.id = s.from_id
    JOIN concepts ct ON ct.id = s.to_id`;

export function listPrerequisiteSuggestions(
  db: DatabaseSync,
  sourceId: number,
  status: SuggestionStatus = 'pending',
): PrerequisiteSuggestion[] {
  return (db
    .prepare(`${SUGGESTION_SELECT} WHERE s.source_id = ? AND s.status = ? ORDER BY s.confidence DESC, s.id`)
    .all(sourceId, status) as unknown as SuggestionRow[])
    .map(rowToSuggestion);
}

export function getPrerequisiteSuggestion(db: DatabaseSync, id: number): PrerequisiteSuggestion | null {
  const row = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`).get(id) as SuggestionRow | undefined;
  return row ? rowToSuggestion(row) : null;
}

// Accept a suggestion: write the real user-curated concept_edges row and mark
// the suggestion accepted. Returns the created edge id (or null if the edge
// already existed / was a self-edge guarded away). Emits an event.
export function acceptPrerequisiteSuggestion(db: DatabaseSync, id: number): PrerequisiteSuggestion | null {
  const s = getPrerequisiteSuggestion(db, id);
  if (!s) return null;
  // createEdge guards self-edges and dedupes via UNIQUE; safe to call blindly.
  createEdge(db, s.from_id, s.to_id, s.edge_type);
  db.prepare(`UPDATE prerequisite_suggestions SET status = 'accepted' WHERE id = ?`).run(id);
  emitEvent(
    db,
    'prerequisite.suggestion_accepted',
    { suggestionId: id, fromId: s.from_id, toId: s.to_id, edgeType: s.edge_type },
    { entityType: 'concept', entityId: s.to_id },
  );
  return getPrerequisiteSuggestion(db, id);
}

export function rejectPrerequisiteSuggestion(db: DatabaseSync, id: number): PrerequisiteSuggestion | null {
  const s = getPrerequisiteSuggestion(db, id);
  if (!s) return null;
  db.prepare(`UPDATE prerequisite_suggestions SET status = 'dismissed' WHERE id = ?`).run(id);
  return getPrerequisiteSuggestion(db, id);
}

// Wipe all suggestions for a source — derived data, cleared on re-extract.
export function clearPrerequisiteSuggestionsForSource(db: DatabaseSync, sourceId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM prerequisite_suggestions WHERE source_id = ?')
    .get(sourceId) as { c: number };
  db.prepare('DELETE FROM prerequisite_suggestions WHERE source_id = ?').run(sourceId);
  return row.c;
}
