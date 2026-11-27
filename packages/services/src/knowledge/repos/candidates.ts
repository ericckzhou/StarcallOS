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
import { rejectedKeys } from './rejections';

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
    section_source: (row.parser_diagnostics_json
      ? ((JSON.parse(row.parser_diagnostics_json) as { section_source?: string }).section_source ?? 'none')
      : 'none') as ConceptCandidate['section_source'],
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

// Who wrote a candidate row (migrations 0039/0040). 'parser' rows are
// regenerable; 'user' rows (Candidate Review add) survive re-extract. The
// default is 'user' so a caller that forgets to say errs toward preserving.
export type CandidateOrigin = 'parser' | 'user';

const normText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
// Full identity of a relation as the parser emitted it, quote included: two
// relations with the same endpoints, kind and page but different quotes are
// different candidates. Stored as source_key on parser rows and used for
// rejections.
export function relationKey(r: { from: string; to: string; kind: string; page: number; quote: string }): string {
  return `${relationCoarseKey(r)}|${normText(r.quote ?? '')}`;
}
// Coarse identity (no quote). Used ONLY to recognise a user-created row as a
// copy of parser output; never to match a parser-origin row, whose full
// original identity is known.
export function relationCoarseKey(r: { from: string; to: string; kind: string; page: number }): string {
  return `${r.page}|${normText(r.from)}|${normText(r.to)}|${r.kind}`;
}
export function misconceptionKey(m: { quote: string; page: number }): string {
  return `${Math.max(0, Math.floor(m.page))}|${normText(m.quote)}`;
}

export function createRelationCandidate(
  db: DatabaseSync,
  sourceId: number,
  r: RelationCandidate,
  origin: CandidateOrigin = 'user',
): StoredRelationCandidate {
  const result = db.prepare(
    `INSERT INTO relation_candidates
       (source_id, from_term, to_term, relation_kind, quote, page, parser_version, origin, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, r.from, r.to, r.kind, r.quote, r.page, PARSER_VERSION, origin,
    origin === 'parser' ? relationKey(r) : null);
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
  // A user edit makes the row user-owned: re-extract keeps it.
  db.prepare(
    `UPDATE relation_candidates
     SET from_term = ?, to_term = ?, relation_kind = ?, quote = ?, page = ?, user_modified_at = datetime('now')
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
  origin: CandidateOrigin = 'user',
): StoredMisconceptionCandidate {
  const quote = m.quote.trim();
  if (!quote) throw new Error('Misconception phrase cannot be empty.');
  const result = db.prepare(
    `INSERT INTO misconception_candidates
       (source_id, quote, page, section_path, parser_version, origin, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, quote, Math.max(0, Math.floor(m.page)), JSON.stringify(m.section_path), PARSER_VERSION, origin,
    origin === 'parser' ? misconceptionKey({ quote, page: m.page }) : null);
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
  // A user edit makes the row user-owned: re-extract keeps it.
  db.prepare(
    `UPDATE misconception_candidates
     SET quote = ?, page = ?, section_path = ?, user_modified_at = datetime('now')
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
  // Parser output: regenerable on re-extract (origin 'parser'), remembering the
  // emitted LaTeX so a later edit doesn't make the parser re-add its original.
  const result = db.prepare(
    `INSERT INTO equation_candidates
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version, origin, source_latex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'parser', ?)`,
  ).run(
    sourceId,
    eq.latex,
    JSON.stringify(eq.variables),
    eq.page,
    eq.reading_order,
    JSON.stringify(eq.section_path),
    eq.attached_term,
    PARSER_VERSION,
    eq.latex,
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
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
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
       (source_id, latex, variables, page, reading_order, section_path, attached_term, parser_version, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
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
  // A user edit makes the row user-owned: re-extract keeps it (user_modified_at).
  // attached_term changes only when the caller passes the key: the concept
  // Overview editor omits it, and treating "omitted" as null used to detach
  // the edited equation from its concept.
  const attachedTerm = 'attached_term' in input
    ? (input.attached_term ? normalizeAttachedTerm(input.attached_term) : null)
    : existing.attached_term;
  db.prepare(
    `UPDATE equation_candidates
     SET latex = ?, variables = ?, page = ?, section_path = ?, attached_term = ?, user_modified_at = datetime('now')
     WHERE id = ?`,
  ).run(
    latex,
    JSON.stringify(input.variables?.length ? input.variables : inferEquationVariables(latex)),
    Math.max(0, Math.floor(input.page ?? existing.page)),
    JSON.stringify(input.section_path ?? (JSON.parse(existing.section_path) as string[])),
    attachedTerm,
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

// Candidate rows a re-extract may delete: unedited parser output. User-created,
// user-edited and unknown-origin (pre-0039/0040) rows are user-owned and
// survive. Same rule for every user-editable candidate table.
const DISPOSABLE_CANDIDATE_WHERE = `source_id = ? AND origin = 'parser' AND user_modified_at IS NULL`;
export const DISPOSABLE_EQUATION_WHERE = DISPOSABLE_CANDIDATE_WHERE;
export const DISPOSABLE_RELATION_WHERE = DISPOSABLE_CANDIDATE_WHERE;
export const DISPOSABLE_MISCONCEPTION_WHERE = DISPOSABLE_CANDIDATE_WHERE;

// Concept candidates are parser output only (users promote or reject them,
// never author or edit them), so they are always regenerated.
export function clearCandidatesForSource(db: DatabaseSync, sourceId: number): void {
  db.prepare('DELETE FROM concept_candidates WHERE source_id = ?').run(sourceId);
  db.prepare(`DELETE FROM relation_candidates WHERE ${DISPOSABLE_RELATION_WHERE}`).run(sourceId);
  db.prepare(`DELETE FROM misconception_candidates WHERE ${DISPOSABLE_MISCONCEPTION_WHERE}`).run(sourceId);
  db.prepare(`DELETE FROM equation_candidates WHERE ${DISPOSABLE_EQUATION_WHERE}`).run(sourceId);
}

// Identity of an equation for "is this parser output already present?":
// page + whitespace-insensitive LaTeX. Preserved rows match on the LaTeX the
// parser originally emitted (source_latex), falling back to their current
// LaTeX for user-created rows.
function equationKey(page: number, latex: string): string {
  return `${page}|${latex.replace(/\s+/g, '')}`;
}

// Keep only the parser items not already represented by a preserved
// (user-owned / unknown-origin) row, as a multiset: an item the parser emits
// twice is still inserted once more than is preserved. A preserved row's key
// is the identity the parser originally gave it (so a user's edit doesn't make
// the parser re-add the original beside it), else its current content.
function notYetPresent<T>(preservedKeys: string[], items: T[], keyOf: (item: T) => string): T[] {
  const left = new Map<string, number>();
  for (const k of preservedKeys) left.set(k, (left.get(k) ?? 0) + 1);
  return items.filter(item => {
    const k = keyOf(item);
    const n = left.get(k) ?? 0;
    if (n === 0) return true;
    left.set(k, n - 1);
    return false;
  });
}

function newParserEquations(db: DatabaseSync, sourceId: number, equations: EquationCandidate[]): EquationCandidate[] {
  const keys = (db.prepare(
    'SELECT page, COALESCE(source_latex, latex) AS k FROM equation_candidates WHERE source_id = ?',
  ).all(sourceId) as Array<{ page: number; k: string }>).map(r => equationKey(Number(r.page), r.k));
  return notYetPresent(keys, equations, eq => equationKey(eq.page, eq.latex));
}

// Two passes, so the identity is never weaker than what is known:
//   1. exact: a parser-origin row (edited or not) matches only its recorded
//      original identity (source_key); an unknown-origin legacy row matches
//      its current full content. No coarse fallback for either: if a parser
//      row's original no longer matches, the parser's new output is genuinely
//      new and is added beside the kept row.
//   2. coarse: only user-created rows (no parser identity) match on page +
//      endpoints + kind, so a user's copy of parser output isn't duplicated.
function newParserRelations(db: DatabaseSync, sourceId: number, relations: RelationCandidate[]): RelationCandidate[] {
  const kept = db.prepare(
    'SELECT origin, source_key, from_term, to_term, relation_kind, quote, page FROM relation_candidates WHERE source_id = ?',
  ).all(sourceId) as Array<{ origin: string | null; source_key: string | null; from_term: string; to_term: string; relation_kind: string; quote: string; page: number }>;
  const asCandidate = (r: (typeof kept)[number]) => ({ from: r.from_term, to: r.to_term, kind: r.relation_kind, page: Number(r.page), quote: r.quote });
  const exact = kept.filter(r => r.origin !== 'user').map(r => r.source_key ?? relationKey(asCandidate(r)));
  const coarse = kept.filter(r => r.origin === 'user').map(r => relationCoarseKey(asCandidate(r)));
  return notYetPresent(coarse, notYetPresent(exact, relations, relationKey), relationCoarseKey);
}

function newParserMisconceptions<T extends { quote: string; page: number }>(db: DatabaseSync, sourceId: number, phrases: T[]): T[] {
  const keys = (db.prepare(
    'SELECT source_key, quote, page FROM misconception_candidates WHERE source_id = ?',
  ).all(sourceId) as Array<{ source_key: string | null; quote: string; page: number }>)
    .map(r => r.source_key ?? misconceptionKey({ quote: r.quote, page: Number(r.page) }));
  return notYetPresent(keys, phrases, misconceptionKey);
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
  // Atomic: a failure part-way leaves the previous candidates in place rather
  // than a half-written set. SAVEPOINT so it also nests in a caller's transaction.
  db.exec('SAVEPOINT persist_candidates');
  try {
    persistCandidateExtractionInner(db, sourceId, result);
    db.exec('RELEASE persist_candidates');
  } catch (e) {
    db.exec('ROLLBACK TO persist_candidates');
    db.exec('RELEASE persist_candidates');
    throw e;
  }
}

function persistCandidateExtractionInner(
  db: DatabaseSync,
  sourceId: number,
  result: Parameters<typeof persistCandidateExtraction>[2],
): void {
  clearCandidatesForSource(db, sourceId);
  // Parser output the user rejected stays rejected (repos/rejections.ts).
  const rejectedConcepts = rejectedKeys(db, sourceId, 'concept');
  const rejectedRelations = rejectedKeys(db, sourceId, 'relation');
  const rejectedMisconceptions = rejectedKeys(db, sourceId, 'misconception');
  result = {
    ...result,
    candidates: result.candidates.filter(c => !rejectedConcepts.has(c.normalized)),
    relations: result.relations.filter(r => !rejectedRelations.has(relationKey(r))),
    misconception_phrases: result.misconception_phrases.filter(m => !rejectedMisconceptions.has(misconceptionKey(m))),
  };
  for (const c of result.candidates) createConceptCandidate(db, sourceId, c);
  for (const r of newParserRelations(db, sourceId, result.relations)) createRelationCandidate(db, sourceId, r, 'parser');
  for (const m of newParserMisconceptions(db, sourceId, result.misconception_phrases)) createMisconceptionCandidate(db, sourceId, m, 'parser');
  for (const eq of newParserEquations(db, sourceId, result.equations ?? [])) createEquationCandidate(db, sourceId, eq);
}
