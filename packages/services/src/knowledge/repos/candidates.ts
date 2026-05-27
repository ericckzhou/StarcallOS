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

function normalizeAttachedTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
}

function inferEquationVariables(latex: string): string[] {
  const seen = new Set<string>();
  for (const match of latex.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/g)) {
    const token = match[0];
    if (token.length > 12) continue;
    if (/^(sum|frac|text|sqrt|exp|log|ln|min|max|sin|cos|tan|where|and|or|the|to|of|in)$/i.test(token)) continue;
    seen.add(token);
  }
  return [...seen].slice(0, 12);
}

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
  reject_reasons_json?: string;
  typography_score?: number;
  signal_score?: number;
  quality_score?: number;
  context_score?: number;
  final_score?: number;
  labels_json?: string;
  typography_signals_json?: string;
  context_snippet?: string;
  parser_diagnostics_json?: string;
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
    typography_score: row.typography_score ?? 0,
    signal_score: row.signal_score ?? row.confidence,
    quality_score: row.quality_score ?? 0,
    context_score: row.context_score ?? (row.topic_relevance_score ?? 1.0),
    final_score: row.final_score ?? row.concept_score ?? row.confidence,
    labels: row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [],
    typography_signals: row.typography_signals_json
      ? (JSON.parse(row.typography_signals_json) as Record<string, unknown>)
      : {},
    context_snippet: row.context_snippet ?? '',
    parser_diagnostics: row.parser_diagnostics_json
      ? (JSON.parse(row.parser_diagnostics_json) as Record<string, unknown>)
      : {},
    reject_reasons: row.reject_reasons_json
      ? (JSON.parse(row.reject_reasons_json) as string[])
      : [],
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
        concept_score, reject_reasons_json,
        typography_score, signal_score, quality_score, context_score, final_score,
        labels_json, typography_signals_json, context_snippet, parser_diagnostics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    JSON.stringify(c.reject_reasons ?? []),
    c.typography_score ?? 0,
    c.signal_score ?? c.confidence,
    c.quality_score ?? 0,
    c.context_score ?? c.topic_relevance_score ?? 1.0,
    c.final_score ?? c.concept_score ?? c.confidence,
    JSON.stringify(c.labels ?? []),
    JSON.stringify(c.typography_signals ?? {}),
    c.context_snippet ?? '',
    JSON.stringify(c.parser_diagnostics ?? {}),
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
         ORDER BY final_score DESC, concept_score DESC, confidence DESC, mention_count DESC`,
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
): StoredRelationCandidate {
  const result = db.prepare(
    `INSERT INTO relation_candidates
       (source_id, from_term, to_term, relation_kind, quote, page, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, r.from, r.to, r.kind, r.quote, r.page, PARSER_VERSION);
  const row = db
    .prepare('SELECT * FROM relation_candidates WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as RelationCandidateRow | undefined;
  if (!row) throw new Error('Failed to create relation candidate.');
  return rowToRelationCandidate(row);
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

export function updateRelationCandidate(
  db: DatabaseSync,
  id: number,
  input: { from: string; to: string; kind: RelationKind; quote?: string; page?: number },
): StoredRelationCandidate {
  const from = input.from.trim();
  const to = input.to.trim();
  if (!from || !to) throw new Error('Relation endpoints cannot be empty.');
  db.prepare(
    `UPDATE relation_candidates
     SET from_term = ?, to_term = ?, relation_kind = ?, quote = ?, page = ?
     WHERE id = ?`,
  ).run(from, to, input.kind, input.quote?.trim() ?? '', Math.max(0, Math.floor(input.page ?? 0)), id);
  const row = db
    .prepare('SELECT * FROM relation_candidates WHERE id = ?')
    .get(id) as unknown as RelationCandidateRow | undefined;
  if (!row) throw new Error(`Relation candidate ${id} not found.`);
  return rowToRelationCandidate(row);
}

export function deleteRelationCandidate(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM relation_candidates WHERE id = ?').run(id);
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
): StoredMisconceptionCandidate {
  const quote = m.quote.trim();
  if (!quote) throw new Error('Misconception phrase cannot be empty.');
  const result = db.prepare(
    `INSERT INTO misconception_candidates
       (source_id, quote, page, section_path, parser_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceId, quote, Math.max(0, Math.floor(m.page)), JSON.stringify(m.section_path), PARSER_VERSION);
  const row = db
    .prepare('SELECT * FROM misconception_candidates WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as MisconceptionCandidateRow | undefined;
  if (!row) throw new Error('Failed to create misconception candidate.');
  return rowToMisconceptionCandidate(row);
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

export function updateMisconceptionCandidate(
  db: DatabaseSync,
  id: number,
  input: { quote: string; page?: number; section_path?: string[] },
): StoredMisconceptionCandidate {
  const quote = input.quote.trim();
  if (!quote) throw new Error('Misconception phrase cannot be empty.');
  db.prepare(
    `UPDATE misconception_candidates
     SET quote = ?, page = ?, section_path = ?
     WHERE id = ?`,
  ).run(quote, Math.max(0, Math.floor(input.page ?? 0)), JSON.stringify(input.section_path ?? []), id);
  const row = db
    .prepare('SELECT * FROM misconception_candidates WHERE id = ?')
    .get(id) as unknown as MisconceptionCandidateRow | undefined;
  if (!row) throw new Error(`Misconception candidate ${id} not found.`);
  return rowToMisconceptionCandidate(row);
}

export function deleteMisconceptionCandidate(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM misconception_candidates WHERE id = ?').run(id);
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
): StoredEquationCandidate {
  const result = db.prepare(
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
  const row = db
    .prepare('SELECT * FROM equation_candidates WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as EquationCandidateRow | undefined;
  if (!row) throw new Error('Failed to create equation candidate.');
  return rowToEquationCandidate(row);
}

export function listEquationCandidatesForConcept(
  db: DatabaseSync,
  conceptId: number,
): StoredEquationCandidate[] {
  const c = db
    .prepare('SELECT source_id, name FROM concepts WHERE id = ?')
    .get(conceptId) as { source_id: number; name: string } | undefined;
  if (!c) return [];
  const term = normalizeAttachedTerm(c.name);
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

export function createManualEquationForConcept(
  db: DatabaseSync,
  input: { conceptId: number; latex: string; page?: number; variables?: string[] },
): StoredEquationCandidate {
  const concept = db
    .prepare('SELECT source_id, name, section_path FROM concepts WHERE id = ?')
    .get(input.conceptId) as { source_id: number; name: string; section_path: string } | undefined;
  if (!concept) throw new Error(`concept ${input.conceptId} not found`);

  const latex = input.latex.trim();
  if (!latex) throw new Error('Equation cannot be empty.');

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(reading_order), 0) AS max_order FROM equation_candidates WHERE source_id = ?')
    .get(concept.source_id) as { max_order: number } | undefined;
  const variables = input.variables?.length ? input.variables : inferEquationVariables(latex);
  const result = db.prepare(
    `INSERT INTO equation_candidates
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    concept.source_id,
    latex,
    JSON.stringify(variables),
    Math.max(0, Math.floor(input.page ?? 0)),
    Number(maxOrder?.max_order ?? 0) + 1,
    concept.section_path || '[]',
    normalizeAttachedTerm(concept.name),
    PARSER_VERSION,
  );

  const row = db
    .prepare('SELECT * FROM equation_candidates WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as EquationCandidateRow | undefined;
  if (!row) throw new Error('Failed to create equation.');
  return rowToEquationCandidate(row);
}

export function deleteEquationCandidate(db: DatabaseSync, equationId: number): void {
  db.prepare('DELETE FROM equation_candidates WHERE id = ?').run(equationId);
}

export function createEquationCandidateForSource(
  db: DatabaseSync,
  input: { sourceId: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null },
): StoredEquationCandidate {
  const latex = input.latex.trim();
  if (!latex) throw new Error('Equation cannot be empty.');
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(reading_order), 0) AS max_order FROM equation_candidates WHERE source_id = ?')
    .get(input.sourceId) as { max_order: number } | undefined;
  const result = db.prepare(
    `INSERT INTO equation_candidates
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sourceId,
    latex,
    JSON.stringify(input.variables?.length ? input.variables : inferEquationVariables(latex)),
    Math.max(0, Math.floor(input.page ?? 0)),
    Number(maxOrder?.max_order ?? 0) + 1,
    JSON.stringify(input.section_path ?? []),
    input.attached_term ? normalizeAttachedTerm(input.attached_term) : null,
    PARSER_VERSION,
  );
  const row = db
    .prepare('SELECT * FROM equation_candidates WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as EquationCandidateRow | undefined;
  if (!row) throw new Error('Failed to create equation candidate.');
  return rowToEquationCandidate(row);
}

export function updateEquationCandidate(
  db: DatabaseSync,
  id: number,
  input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null },
): StoredEquationCandidate {
  const existing = db
    .prepare('SELECT * FROM equation_candidates WHERE id = ?')
    .get(id) as unknown as EquationCandidateRow | undefined;
  if (!existing) throw new Error(`Equation candidate ${id} not found.`);
  const latex = input.latex.trim();
  if (!latex) throw new Error('Equation cannot be empty.');
  db.prepare(
    `UPDATE equation_candidates
     SET latex = ?, variables = ?, page = ?, section_path = ?, attached_term = ?
     WHERE id = ?`,
  ).run(
    latex,
    JSON.stringify(input.variables?.length ? input.variables : inferEquationVariables(latex)),
    Math.max(0, Math.floor(input.page ?? existing.page)),
    JSON.stringify(input.section_path ?? (JSON.parse(existing.section_path) as string[])),
    input.attached_term ? normalizeAttachedTerm(input.attached_term) : null,
    id,
  );
  const row = db
    .prepare('SELECT * FROM equation_candidates WHERE id = ?')
    .get(id) as unknown as EquationCandidateRow | undefined;
  if (!row) throw new Error(`Equation candidate ${id} not found.`);
  return rowToEquationCandidate(row);
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
