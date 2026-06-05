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
import { chatJSON, type ProviderConfig } from '../core/llm';

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
  // Resolve relation terms cross-source, conservatively: a name that matches a
  // promoted concept ON THIS SOURCE wins (same-source-first); otherwise accept a
  // match on another source ONLY if it is globally unambiguous (exactly one
  // promoted concept with that name anywhere). Ambiguous names resolve to
  // nothing, so a collision never produces a wrong edge.
  const localByName = new Map<string, number>();
  for (const c of db
    .prepare('SELECT id, name FROM concepts WHERE source_id = ?')
    .all(sourceId) as Array<{ id: number | bigint; name: string }>) {
    localByName.set(normalizeName(c.name), Number(c.id));
  }
  const globalByName = new Map<string, number[]>();
  for (const c of db
    .prepare('SELECT id, name FROM concepts')
    .all() as Array<{ id: number | bigint; name: string }>) {
    const k = normalizeName(c.name);
    (globalByName.get(k) ?? globalByName.set(k, []).get(k)!).push(Number(c.id));
  }
  const conceptIdByName = new Map<string, number>();
  for (const [name, ids] of globalByName) {
    if (localByName.has(name)) conceptIdByName.set(name, localByName.get(name)!);
    else if (ids.length === 1) conceptIdByName.set(name, ids[0]);
    // else ambiguous across sources → leave unmapped (skip).
  }

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

// Contract: ../../../../contracts/prereq_suggest.md (CONTRACT_VERSION). Lazy,
// user-triggered, pay-per-use (like enrich/lazy_tasks) — NOT part of the $0
// default path. Proposes prerequisite edges among a source's promoted concepts
// from their definitions; output is still only SUGGESTIONS the user must accept.
const PREREQ_SUGGEST_SYSTEM = `You map prerequisite structure between concepts a learner is studying.
You are given a numbered list of concepts (name + short definition) from ONE source.
Identify which concepts must be understood BEFORE others — true learning prerequisites,
not mere relatedness. A prerequisite edge means: to understand the "dependent", the
learner should first understand the "prerequisite".

Rules:
- Use ONLY the provided concepts; refer to them by their exact names.
- Prefer a small number of high-confidence, foundational → advanced edges.
- Do NOT output an edge between a concept and itself.
- Do NOT invent relationships that are merely topical; require a genuine
  "you need A to grasp B" dependency.

Respond ONLY with JSON:
{ "edges": [ { "prerequisite": "<exact concept name>", "dependent": "<exact concept name>" } ] }`;

// Cap how many concepts we send so the prompt stays within low Groq TPM tiers.
const PREREQ_SUGGEST_MAX_CONCEPTS = 60;

interface LlmEdge { prerequisite?: string; dependent?: string }

// Lazy LLM prerequisite suggester. Reads the source's promoted concepts, asks
// the configured provider to propose prerequisite edges, and writes them as
// pending suggestions (basis 'llm'). Never writes a real edge — the user still
// accepts each one. Returns the same shape as the deterministic computer.
export async function suggestLlmPrerequisites(
  config: ProviderConfig,
  db: DatabaseSync,
  sourceId: number,
): Promise<ComputeSuggestionsResult> {
  const concepts = db
    .prepare(
      `SELECT id, name, definition_text
         FROM concepts
        WHERE source_id = ?
        ORDER BY centrality_score DESC, importance, name
        LIMIT ?`,
    )
    .all(sourceId, PREREQ_SUGGEST_MAX_CONCEPTS) as Array<{ id: number | bigint; name: string; definition_text: string }>;

  let created = 0;
  let skippedExistingEdge = 0;
  let skippedUnresolved = 0;
  if (concepts.length < 2) return { created, skippedExistingEdge, skippedUnresolved };

  const conceptIdByName = new Map<string, number>();
  for (const c of concepts) conceptIdByName.set(normalizeName(c.name), Number(c.id));

  const list = concepts
    .map((c, i) => {
      const def = (c.definition_text || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      return `${i + 1}. ${c.name}${def ? ` — ${def}` : ''}`;
    })
    .join('\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: PREREQ_SUGGEST_SYSTEM },
        { role: 'user', content: `Concepts:\n${list}` },
      ],
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1024,
    },
    'prereq_suggest',
  );

  let edges: LlmEdge[] = [];
  try {
    const parsed = JSON.parse(content || '{"edges":[]}') as { edges?: LlmEdge[] };
    edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  } catch {
    return { created, skippedExistingEdge, skippedUnresolved };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO prerequisite_suggestions
       (source_id, from_id, to_id, edge_type, basis, confidence, reason, status)
     VALUES (?, ?, ?, 'requires', 'llm', 0.5, ?, 'pending')`,
  );

  for (const e of edges) {
    const prereqId = e.prerequisite ? conceptIdByName.get(normalizeName(e.prerequisite)) : undefined;
    const dependentId = e.dependent ? conceptIdByName.get(normalizeName(e.dependent)) : undefined;
    if (prereqId == null || dependentId == null || prereqId === dependentId) { skippedUnresolved += 1; continue; }
    if (edgeExists(db, prereqId, dependentId, 'requires')) { skippedExistingEdge += 1; continue; }
    const res = insert.run(sourceId, prereqId, dependentId, `Suggested prerequisite of ${e.dependent}`);
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

// Suggestions touching a specific concept on EITHER endpoint, across any
// source. Powers the DetailPane panel so a cross-source suggestion surfaces on
// both the prerequisite's and the dependent's panel, regardless of which source
// the relation was found in.
export function listPrerequisiteSuggestionsForConcept(
  db: DatabaseSync,
  conceptId: number,
  status: SuggestionStatus = 'pending',
): PrerequisiteSuggestion[] {
  return (db
    .prepare(`${SUGGESTION_SELECT} WHERE (s.from_id = ? OR s.to_id = ?) AND s.status = ? ORDER BY s.confidence DESC, s.id`)
    .all(conceptId, conceptId, status) as unknown as SuggestionRow[])
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
