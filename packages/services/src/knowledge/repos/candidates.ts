import type { DatabaseSync } from '../../core/infra/sqlite';
import type {
  ConceptCandidate,
  RelationCandidate,
  EvidenceSpan,
  CandidateSource,
} from '../../ingestion/candidates';
import type { RelationKind } from '../../ingestion/grammar';
import type { EquationCandidate } from '../../ingestion/equations';
import { PARSER_VERSION } from '../../core/version';

// ─── Concept candidates ───────────────────────────────────────────────────────

export interface StoredConceptCandidate extends ConceptCandidate {
  id: number;
  source_id: number;
  signals: CandidateSource[];
  created_at: string;
  topic_relevance_score: number;
  topic_relevance_reasons: string[];
  is_boilerplate: boolean;
  is_broad: boolean;
}

interface ConceptCandidateRow {
  id: number | bigint;
  source_id: number | bigint;
  term: string;
  normalized: string;
  confidence: number;
  mention_count: number;
  first_page: number;
  section_path: string;
  evidence: string;
  signals: string;
  created_at: string;
  topic_relevance_score?: number;
  topic_relevance_reasons_json?: string;
  is_boilerplate?: number;
  is_broad?: number;
  concept_score?: number;
}

function rowToConceptCandidate(row: ConceptCandidateRow): StoredConceptCandidate {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    term: row.term,
    normalized: row.normalized,
    confidence: row.confidence,
    mention_count: row.mention_count,
    first_page: row.first_page,
    section_path: JSON.parse(row.section_path) as string[],
    evidence: JSON.parse(row.evidence) as EvidenceSpan[],
    signals: JSON.parse(row.signals) as CandidateSource[],
    created_at: row.created_at,
    topic_relevance_score: row.topic_relevance_score ?? 1.0,
    topic_relevance_reasons: row.topic_relevance_reasons_json
      ? (JSON.parse(row.topic_relevance_reasons_json) as string[])
      : [],
    is_boilerplate: !!row.is_boilerplate,
    is_broad: !!row.is_broad,
    concept_score: row.concept_score ?? 0,
    reject_reasons: [], // not persisted yet; recompute on demand if needed
  };
}

export function createConceptCandidate(
  db: DatabaseSync,
  sourceId: number,
  c: ConceptCandidate,
): void {
  const signals = [...new Set(c.evidence.map(e => e.source))];
  db.prepare(
    `INSERT INTO concept_candidates
       (source_id, term, normalized, confidence, mention_count, first_page,
        section_path, evidence, signals, parser_version,
        topic_relevance_score, topic_relevance_reasons_json, is_boilerplate, is_broad,
        concept_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    c.term,
    c.normalized,
    c.confidence,
    c.mention_count,
    c.first_page,
    JSON.stringify(c.section_path),
    JSON.stringify(c.evidence),
    JSON.stringify(signals),
    PARSER_VERSION,
    c.topic_relevance_score ?? 1.0,
    JSON.stringify(c.topic_relevance_reasons ?? []),
    c.is_boilerplate ? 1 : 0,
    c.is_broad ? 1 : 0,
    c.concept_score ?? 0,
  );
}

export function listConceptCandidatesBySource(
  db: DatabaseSync,
  sourceId: number,
): StoredConceptCandidate[] {
  return (
    db
      .prepare(
        `SELECT * FROM concept_candidates
         WHERE source_id = ?
         ORDER BY concept_score DESC, confidence DESC, mention_count DESC`,
      )
      .all(sourceId) as unknown as ConceptCandidateRow[]
  ).map(rowToConceptCandidate);
}

// ─── Relation candidates ──────────────────────────────────────────────────────

export interface StoredRelationCandidate extends RelationCandidate {
  id: number;
  source_id: number;
  created_at: string;
}

interface RelationCandidateRow {
  id: number | bigint;
  source_id: number | bigint;
  from_term: string;
  to_term: string;
  relation_kind: string;
  quote: string;
  page: number;
  created_at: string;
}

function rowToRelationCandidate(row: RelationCandidateRow): StoredRelationCandidate {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    from: row.from_term,
    to: row.to_term,
    kind: row.relation_kind as RelationKind,
    quote: row.quote,
    page: row.page,
    created_at: row.created_at,
  };
}

export function createRelationCandidate(
  db: DatabaseSync,
  sourceId: number,
  r: RelationCandidate,
): void {
  db.prepare(
    `INSERT INTO relation_candidates
       (source_id, from_term, to_term, relation_kind, quote, page, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, r.from, r.to, r.kind, r.quote, r.page, PARSER_VERSION);
}

export function listRelationCandidatesBySource(
  db: DatabaseSync,
  sourceId: number,
): StoredRelationCandidate[] {
  return (
    db
      .prepare('SELECT * FROM relation_candidates WHERE source_id = ? ORDER BY id')
      .all(sourceId) as unknown as RelationCandidateRow[]
  ).map(rowToRelationCandidate);
}

// ─── Misconception candidates ─────────────────────────────────────────────────

export interface StoredMisconceptionCandidate {
  id: number;
  source_id: number;
  quote: string;
  page: number;
  section_path: string[];
  created_at: string;
}

interface MisconceptionCandidateRow {
  id: number | bigint;
  source_id: number | bigint;
  quote: string;
  page: number;
  section_path: string;
  created_at: string;
}

function rowToMisconceptionCandidate(row: MisconceptionCandidateRow): StoredMisconceptionCandidate {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    quote: row.quote,
    page: row.page,
    section_path: JSON.parse(row.section_path) as string[],
    created_at: row.created_at,
  };
}

export function createMisconceptionCandidate(
  db: DatabaseSync,
  sourceId: number,
  m: { quote: string; page: number; section_path: string[] },
): void {
  db.prepare(
    `INSERT INTO misconception_candidates
       (source_id, quote, page, section_path, parser_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceId, m.quote, m.page, JSON.stringify(m.section_path), PARSER_VERSION);
}

export function listMisconceptionCandidatesBySource(
  db: DatabaseSync,
  sourceId: number,
): StoredMisconceptionCandidate[] {
  return (
    db
      .prepare('SELECT * FROM misconception_candidates WHERE source_id = ? ORDER BY id')
      .all(sourceId) as unknown as MisconceptionCandidateRow[]
  ).map(rowToMisconceptionCandidate);
}

export function getConceptCandidateById(
  db: DatabaseSync,
  id: number,
): StoredConceptCandidate | null {
  const row = db
    .prepare('SELECT * FROM concept_candidates WHERE id = ?')
    .get(id) as ConceptCandidateRow | undefined;
  return row != null ? rowToConceptCandidate(row) : null;
}

export function deleteConceptCandidate(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM concept_candidates WHERE id = ?').run(id);
}

// ─── Equation candidates ──────────────────────────────────────────────────────

export interface StoredEquationCandidate extends EquationCandidate {
  id: number;
  source_id: number;
  created_at: string;
}

interface EquationCandidateRow {
  id: number | bigint;
  source_id: number | bigint;
  latex: string;
  variables: string;
  page: number;
  reading_order: number;
  section_path: string;
  attached_term: string | null;
  created_at: string;
}

function rowToEquationCandidate(row: EquationCandidateRow): StoredEquationCandidate {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    latex: row.latex,
    variables: JSON.parse(row.variables) as string[],
    page: row.page,
    reading_order: row.reading_order,
    section_path: JSON.parse(row.section_path) as string[],
    attached_term: row.attached_term,
    created_at: row.created_at,
  };
}

export function createEquationCandidate(
  db: DatabaseSync,
  sourceId: number,
  eq: EquationCandidate,
): void {
  db.prepare(
    `INSERT INTO equation_candidates
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    eq.latex,
    JSON.stringify(eq.variables),
    eq.page,
    eq.reading_order,
    JSON.stringify(eq.section_path),
    eq.attached_term,
    PARSER_VERSION,
  );
}

export function listEquationCandidatesForConcept(
  db: DatabaseSync,
  conceptId: number,
): StoredEquationCandidate[] {
  const c = db
    .prepare('SELECT source_id, name FROM concepts WHERE id = ?')
    .get(conceptId) as { source_id: number; name: string } | undefined;
  if (!c) return [];
  const term = c.name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
  return (
    db
      .prepare(
        `SELECT * FROM equation_candidates
         WHERE source_id = ? AND attached_term = ?
         ORDER BY reading_order`,
      )
      .all(c.source_id, term) as unknown as EquationCandidateRow[]
  ).map(rowToEquationCandidate);
}

export function listEquationCandidatesBySource(
  db: DatabaseSync,
  sourceId: number,
): StoredEquationCandidate[] {
  return (
    db
      .prepare('SELECT * FROM equation_candidates WHERE source_id = ? ORDER BY reading_order')
      .all(sourceId) as unknown as EquationCandidateRow[]
  ).map(rowToEquationCandidate);
}

// ─── Idempotency helpers ──────────────────────────────────────────────────────

export function clearCandidatesForSource(db: DatabaseSync, sourceId: number): void {
  db.prepare('DELETE FROM concept_candidates WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM relation_candidates WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM misconception_candidates WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM equation_candidates WHERE source_id = ?').run(sourceId);
}

// ─── Bulk persistence: one extraction → DB ────────────────────────────────────

export function persistCandidateExtraction(
  db: DatabaseSync,
  sourceId: number,
  result: {
    candidates: ConceptCandidate[];
    relations: RelationCandidate[];
    misconception_phrases: Array<{ quote: string; page: number; section_path: string[] }>;
    equations?: EquationCandidate[];
  },
): void {
  clearCandidatesForSource(db, sourceId);
  for (const c of result.candidates) createConceptCandidate(db, sourceId, c);
  for (const r of result.relations) createRelationCandidate(db, sourceId, r);
  for (const m of result.misconception_phrases) createMisconceptionCandidate(db, sourceId, m);
  for (const eq of result.equations ?? []) createEquationCandidate(db, sourceId, eq);
}
