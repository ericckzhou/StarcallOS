import type { DatabaseSync } from '../../core/infra/sqlite';
import type {
  Concept,
  ConceptImportance,
  ConceptEdge,
  EdgeType,
} from '../../core/domain/types';

// ─── Concepts ─────────────────────────────────────────────────────────────────

interface ConceptRow {
  id: number | bigint;
  source_id: number | bigint;
  name: string;
  slug: string;
  importance: string;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string;
  chunk_ids: string;
  section_path: string;
  exam_value: number;
  misconception_risk: number;
  centrality_score: number;
  created_at: string;
  tags_json?: string;
  evidence_json?: string;
  reviewed_at?: string | null;
}

function rowToConcept(row: ConceptRow): Concept {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    name: row.name,
    slug: row.slug,
    importance: row.importance as ConceptImportance,
    definition_text: row.definition_text,
    why_exists: row.why_exists,
    what_breaks: row.what_breaks,
    where_reappears: JSON.parse(row.where_reappears) as string[],
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
    chunk_ids: JSON.parse(row.chunk_ids) as number[],
    section_path: JSON.parse(row.section_path) as string[],
    exam_value: row.exam_value,
    misconception_risk: row.misconception_risk,
    centrality_score: row.centrality_score,
    created_at: row.created_at,
  };
}

export function createConcept(
  db: DatabaseSync,
  input: Omit<Concept, 'id' | 'created_at' | 'tags'>,
): Concept {
  const result = db
    .prepare(
      `INSERT INTO concepts
         (source_id, name, slug, importance, definition_text, why_exists,
          what_breaks, where_reappears, chunk_ids,
          section_path, exam_value, misconception_risk, centrality_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_id,
      input.name,
      input.slug,
      input.importance,
      input.definition_text,
      input.why_exists,
      input.what_breaks,
      JSON.stringify(input.where_reappears),
      JSON.stringify(input.chunk_ids),
      JSON.stringify(input.section_path),
      input.exam_value,
      input.misconception_risk,
      input.centrality_score,
    );
  return getConceptById(db, Number(result.lastInsertRowid))!;
}

export function updateCentralityScore(
  db: DatabaseSync,
  id: number,
  score: number,
): void {
  db.prepare('UPDATE concepts SET centrality_score = ? WHERE id = ?').run(score, id);
}

// Delete a concept and all of its dependent rows (mastery, tasks, records,
// edges, misconceptions). FK CASCADE handles the dependents.
export function deleteConcept(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
}

// Rename a concept's display name. Slug is intentionally NOT updated —
// promotion idempotency depends on (source_id, slug) staying stable across
// re-extracts. Display name is purely user-facing.
export function renameConcept(db: DatabaseSync, id: number, name: string): Concept | null {
  const trimmed = name.trim();
  if (!trimmed) return getConceptById(db, id);
  db.prepare('UPDATE concepts SET name = ? WHERE id = ?').run(trimmed, id);
  return getConceptById(db, id);
}

// Remove a single evidence span from a concept's evidence_json snapshot.
// Match is (page + kind + quote). Returns updated concept.
export function deleteConceptEvidenceSpan(
  db: DatabaseSync,
  conceptId: number,
  page: number,
  kind: string,
  quote: string,
): void {
  const row = db
    .prepare('SELECT evidence_json FROM concepts WHERE id = ?')
    .get(conceptId) as { evidence_json?: string } | undefined;
  if (!row?.evidence_json) return;
  let spans: Array<{ source: string; quote: string; page: number; pattern?: string }>;
  try {
    spans = JSON.parse(row.evidence_json);
    if (!Array.isArray(spans)) return;
  } catch { return; }
  const kindMatch = (s: { source: string }): string =>
    s.source === 'heading' ? 'heading'
    : s.source === 'definition_pattern' ? 'definition'
    : s.source === 'equation' ? 'equation'
    : s.source === 'relation' ? 'relation'
    : s.source === 'first_page' ? 'first_page'
    : s.source === 'highlight' ? 'highlight'
    : 'chunk';
  const next = spans.filter(s =>
    !(s.page === page && kindMatch(s) === kind && (s.quote ?? '') === quote),
  );
  db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?')
    .run(JSON.stringify(next), conceptId);
}

// Manual edits to the narrative fields. Pass only the fields you want to
// change; nullable means "leave existing value alone."
export function updateConceptFields(
  db: DatabaseSync,
  id: number,
  fields: {
    definition_text?: string;
    why_exists?: string;
    what_breaks?: string;
    where_reappears?: Array<string | { name: string; reason?: string }>;
    importance?: string;
    tags?: string[];
  },
): Concept | null {
  const current = getConceptById(db, id);
  if (!current) return null;
  db.prepare(
    `UPDATE concepts
     SET definition_text = ?, why_exists = ?, what_breaks = ?, where_reappears = ?, importance = ?, tags_json = ?
     WHERE id = ?`,
  ).run(
    fields.definition_text ?? current.definition_text,
    fields.why_exists      ?? current.why_exists,
    fields.what_breaks     ?? current.what_breaks,
    JSON.stringify(fields.where_reappears ?? current.where_reappears),
    fields.importance      ?? current.importance,
    JSON.stringify(fields.tags ?? current.tags),
    id,
  );
  return getConceptById(db, id);
}

export function getConceptById(db: DatabaseSync, id: number): Concept | null {
  const row = db
    .prepare('SELECT * FROM concepts WHERE id = ?')
    .get(id) as ConceptRow | undefined;
  return row != null ? rowToConcept(row) : null;
}

export function getConceptBySlug(
  db: DatabaseSync,
  sourceId: number,
  slug: string,
): Concept | null {
  const row = db
    .prepare('SELECT * FROM concepts WHERE source_id = ? AND slug = ?')
    .get(sourceId, slug) as ConceptRow | undefined;
  return row != null ? rowToConcept(row) : null;
}

// Distinct user tags across all concepts — powers the +tag picker.
export function listAllConceptTags(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT tags_json FROM concepts').all() as Array<{ tags_json?: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.tags_json) continue;
    try {
      for (const t of JSON.parse(r.tags_json) as string[]) {
        const v = String(t).trim();
        if (v) set.add(v);
      }
    } catch { /* skip malformed */ }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function listConceptsBySource(db: DatabaseSync, sourceId: number): Concept[] {
  return (
    db
      .prepare('SELECT * FROM concepts WHERE source_id = ? ORDER BY importance, name')
      .all(sourceId) as unknown as ConceptRow[]
  ).map(rowToConcept);
}

// Case-insensitive prefix search over promoted concepts on the same source.
// Powers the typeahead in WhereItReappearsEditor.
export interface ConceptSearchHit {
  id: number;
  name: string;
  importance: string;
  source_filename?: string;
}

export function searchConceptsByPrefix(
  db: DatabaseSync,
  sourceId: number,
  prefix: string,
  limit = 8,
  excludeConceptId?: number,
): ConceptSearchHit[] {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return [];
  // SQLite LIKE on the lowercased name; escape % and _ so user input can't
  // expand the match.
  const escaped = trimmed.toLowerCase().replace(/[\\%_]/g, c => '\\' + c);
  const pattern = `${escaped}%`;
  const exclude = excludeConceptId ?? -1;
  const rows = db
    .prepare(
      `SELECT id, name, importance, centrality_score
         FROM concepts
        WHERE source_id = ?
          AND id != ?
          AND lower(name) LIKE ? ESCAPE '\\'
        ORDER BY centrality_score DESC, name ASC
        LIMIT ?`,
    )
    .all(sourceId, exclude, pattern, limit) as Array<{ id: number | bigint; name: string; importance: string }>;
  return rows.map(r => ({ id: Number(r.id), name: r.name, importance: r.importance }));
}

export function searchConceptsByPrefixGlobal(
  db: DatabaseSync,
  prefix: string,
  limit = 8,
  excludeConceptId?: number,
): ConceptSearchHit[] {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return [];
  const escaped = trimmed.toLowerCase().replace(/[\\%_]/g, c => '\\' + c);
  const pattern = `${escaped}%`;
  const exclude = excludeConceptId ?? -1;
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.importance, c.centrality_score, s.filename AS source_filename
         FROM concepts c
         LEFT JOIN sources s ON s.id = c.source_id
        WHERE c.id != ?
          AND lower(c.name) LIKE ? ESCAPE '\\'
        ORDER BY c.centrality_score DESC, c.name ASC
        LIMIT ?`,
    )
    .all(exclude, pattern, limit) as Array<{ id: number | bigint; name: string; importance: string; source_filename: string | null }>;
  return rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    importance: r.importance,
    source_filename: r.source_filename ?? undefined,
  }));
}

// Convenience wrapper for the renderer: exclude self and search promoted
// concepts across sources so constellations can connect books/domains.
export function searchConceptsByPrefixForConcept(
  db: DatabaseSync,
  conceptId: number,
  prefix: string,
  limit = 8,
): ConceptSearchHit[] {
  const row = db
    .prepare('SELECT id FROM concepts WHERE id = ?')
    .get(conceptId) as { id: number | bigint } | undefined;
  if (!row) return [];
  return searchConceptsByPrefixGlobal(db, prefix, limit, conceptId);
}

export function listConceptsByImportance(
  db: DatabaseSync,
  sourceId: number,
  importance: ConceptImportance,
): Concept[] {
  return (
    db
      .prepare(
        'SELECT * FROM concepts WHERE source_id = ? AND importance = ? ORDER BY name',
      )
      .all(sourceId, importance) as unknown as ConceptRow[]
  ).map(rowToConcept);
}

// ─── Concept Edges ────────────────────────────────────────────────────────────

interface EdgeRow {
  id: number | bigint;
  from_id: number | bigint;
  to_id: number | bigint;
  edge_type: string;
}

function rowToEdge(row: EdgeRow): ConceptEdge {
  return {
    id: Number(row.id),
    from_id: Number(row.from_id),
    to_id: Number(row.to_id),
    edge_type: row.edge_type as EdgeType,
  };
}

export function createEdge(
  db: DatabaseSync,
  fromId: number,
  toId: number,
  edgeType: EdgeType,
): ConceptEdge | null {
  try {
    const result = db
      .prepare('INSERT INTO concept_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)')
      .run(fromId, toId, edgeType);
    const row = db
      .prepare('SELECT * FROM concept_edges WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as unknown as EdgeRow;
    return rowToEdge(row);
  } catch {
    return null; // silently drop duplicate edges (UNIQUE constraint)
  }
}

export function listEdgesForConcept(db: DatabaseSync, conceptId: number): ConceptEdge[] {
  return (
    db
      .prepare('SELECT * FROM concept_edges WHERE from_id = ? OR to_id = ?')
      .all(conceptId, conceptId) as unknown as EdgeRow[]
  ).map(rowToEdge);
}

// ─── Constellation graph ──────────────────────────────────────────────────────
// Read-only global graph for the Map view. Nodes are promoted concepts across
// all sources; edges come from two sources:
//   - constellation: user-curated `where_reappears` links (stored as names,
//     resolved to concept ids; unresolved names are counted as dangling).
//   - relation: validated `concept_edges` (typed; edge_type is the label).
// Capped for v1 performance/clarity; over the cap we keep the highest
// degree+importance nodes.

export interface ConstellationGraphNode {
  id: number;
  name: string;
  slug: string;
  source_id: number;
  source_filename?: string;
  importance: string;
  mastery_stage: number;
  degree: number;
}

export interface ConstellationGraphEdge {
  a: number;
  b: number;
  kind: 'constellation' | 'relation';
  label?: string;
  // true = one-way (a → b); false = mutual / bidirectional (a ↔ b).
  directed?: boolean;
}

export interface ConstellationGraph {
  nodes: ConstellationGraphNode[];
  edges: ConstellationGraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    danglingConstellations: number;
    unresolvedRelations: number;
    duplicateEdges: number;
    capped: boolean;
  };
  statsBySource: Record<number, {
    danglingConstellations: number;
    unresolvedRelations: number;
    duplicateEdges: number;
  }>;
}

const GRAPH_MAX_NODES = 150;
const GRAPH_MAX_EDGES = 300;
const IMPORTANCE_WEIGHT: Record<string, number> = {
  foundational: 4, core: 3, supporting: 2, peripheral: 1, reference_only: 0,
};

function normalizeConceptName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildConstellationGraph(db: DatabaseSync): ConstellationGraph {
  const conceptRows = db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.source_id, c.importance, c.where_reappears,
              s.filename AS source_filename
         FROM concepts c
         LEFT JOIN sources s ON s.id = c.source_id`,
    )
    .all() as Array<{
      id: number | bigint; name: string; slug: string; source_id: number | bigint;
      importance: string; where_reappears: string; source_filename: string | null;
    }>;

  const masteryRows = db
    .prepare('SELECT concept_id, compression_stage FROM mastery')
    .all() as Array<{ concept_id: number | bigint; compression_stage: number }>;
  const masteryByConcept = new Map<number, number>();
  for (const m of masteryRows) masteryByConcept.set(Number(m.concept_id), m.compression_stage);

  // Index promoted concepts by id and by normalized name (names can collide
  // across sources, so map to a list).
  const byId = new Map<number, ConstellationGraphNode>();
  const idsByName = new Map<string, number[]>();
  for (const r of conceptRows) {
    const id = Number(r.id);
    byId.set(id, {
      id,
      name: r.name,
      slug: r.slug,
      source_id: Number(r.source_id),
      source_filename: r.source_filename ?? undefined,
      importance: r.importance,
      mastery_stage: masteryByConcept.get(id) ?? 0,
      degree: 0,
    });
    const key = normalizeConceptName(r.name);
    const list = idsByName.get(key) ?? [];
    list.push(id);
    idsByName.set(key, list);
  }

  let danglingConstellations = 0;
  let unresolvedRelations = 0;
  let duplicateEdges = 0;

  // Per-source tally of the same diagnostics, so the Map footer can scope them
  // to the selected source. Each issue is attributed to the source of the
  // concept that owns it (the link holder / the edge's endpoint).
  const perSource = new Map<number, { danglingConstellations: number; unresolvedRelations: number; duplicateEdges: number }>();
  function bump(sourceId: number | undefined, field: 'danglingConstellations' | 'unresolvedRelations' | 'duplicateEdges'): void {
    if (sourceId == null) return;
    const rec = perSource.get(sourceId) ?? { danglingConstellations: 0, unresolvedRelations: 0, duplicateEdges: 0 };
    rec[field] += 1;
    perSource.set(sourceId, rec);
  }

  function pairKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  // Constellation links are directional in the data (concept A lists B in its
  // where_reappears). Track each unordered pair's two directions so we can tell
  // a one-way link (A→B) apart from a mutual one (A↔B).
  const constByPair = new Map<string, { lo: number; hi: number; loToHi: boolean; hiToLo: boolean; loReason?: string; hiReason?: string }>();
  for (const r of conceptRows) {
    const fromId = Number(r.id);
    let links: Array<unknown> = [];
    try { links = JSON.parse(r.where_reappears) as Array<unknown>; } catch { links = []; }
    for (const raw of links) {
      // Links are a bare name (legacy), { name, reason }, or { name, reason,
      // targetId }. Prefer the stable targetId (rename-proof, unambiguous) and
      // fall back to name resolution when it's absent or its concept is gone.
      const name = typeof raw === 'string' ? raw : (raw as { name?: string })?.name ?? '';
      const reason = typeof raw === 'string' ? '' : ((raw as { reason?: string })?.reason ?? '');
      const targetId = typeof raw === 'string' ? undefined : (raw as { targetId?: number })?.targetId;
      let targets: number[] = [];
      if (targetId != null && byId.has(targetId)) targets = [targetId];
      else if (name) targets = idsByName.get(normalizeConceptName(name)) ?? [];
      if (targets.length === 0) { danglingConstellations += 1; bump(Number(r.source_id), 'danglingConstellations'); continue; }
      for (const toId of targets) {
        if (toId === fromId) continue;
        const lo = Math.min(fromId, toId), hi = Math.max(fromId, toId);
        const key = pairKey(fromId, toId);
        let rec = constByPair.get(key);
        if (!rec) { rec = { lo, hi, loToHi: false, hiToLo: false }; constByPair.set(key, rec); }
        if (fromId === lo) { rec.loToHi = true; if (reason) rec.loReason = reason; }
        else { rec.hiToLo = true; if (reason) rec.hiReason = reason; }
      }
    }
  }

  // Relation edges from validated concept_edges (directional: from → to).
  const relByPair = new Map<string, { a: number; b: number; label?: string }>();
  const edgeRows = db
    .prepare('SELECT from_id, to_id, edge_type FROM concept_edges')
    .all() as Array<{ from_id: number | bigint; to_id: number | bigint; edge_type: string }>;
  for (const e of edgeRows) {
    const a = Number(e.from_id);
    const b = Number(e.to_id);
    if (!byId.has(a) || !byId.has(b) || a === b) {
      unresolvedRelations += 1;
      bump(byId.get(a)?.source_id ?? byId.get(b)?.source_id, 'unresolvedRelations');
      continue;
    }
    const key = pairKey(a, b);
    if (relByPair.has(key)) { duplicateEdges += 1; bump(byId.get(a)?.source_id, 'duplicateEdges'); continue; }
    relByPair.set(key, { a, b, label: e.edge_type });
  }

  // Assemble final edges. Relations own a pair (richer/typed); a constellation
  // on the same pair is dropped as a duplicate. Constellation edges are marked
  // directed (one-way) or bidirectional (mutual), with a→b = source→target for
  // directed ones.
  const edgeByPair = new Map<string, ConstellationGraphEdge>();
  for (const [key, rel] of relByPair) {
    edgeByPair.set(key, { a: rel.a, b: rel.b, kind: 'relation', label: rel.label, directed: true });
  }
  for (const [key, rec] of constByPair) {
    if (edgeByPair.has(key)) { duplicateEdges += 1; bump(byId.get(rec.lo)?.source_id, 'duplicateEdges'); continue; }
    const mutual = rec.loToHi && rec.hiToLo;
    if (mutual) {
      const reason = [rec.loReason, rec.hiReason].filter(Boolean).join('  ·  ') || undefined;
      edgeByPair.set(key, { a: rec.lo, b: rec.hi, kind: 'constellation', directed: false, label: reason });
    } else {
      const from = rec.loToHi ? rec.lo : rec.hi;
      const to = rec.loToHi ? rec.hi : rec.lo;
      const reason = (rec.loToHi ? rec.loReason : rec.hiReason) || undefined;
      edgeByPair.set(key, { a: from, b: to, kind: 'constellation', directed: true, label: reason });
    }
  }

  let edges = [...edgeByPair.values()];

  // Degree (pre-cap) for node ranking + sizing.
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  let nodes = [...byId.values()].map(n => ({ ...n, degree: degree.get(n.id) ?? 0 }));

  let capped = false;
  if (nodes.length > GRAPH_MAX_NODES) {
    capped = true;
    nodes = [...nodes]
      .sort((x, y) =>
        (y.degree + (IMPORTANCE_WEIGHT[y.importance] ?? 0)) -
        (x.degree + (IMPORTANCE_WEIGHT[x.importance] ?? 0)) ||
        y.degree - x.degree)
      .slice(0, GRAPH_MAX_NODES);
    const kept = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => kept.has(e.a) && kept.has(e.b));
  }
  if (edges.length > GRAPH_MAX_EDGES) {
    capped = true;
    const deg = new Map<number, number>();
    for (const n of nodes) deg.set(n.id, n.degree);
    edges = [...edges]
      .sort((x, y) => {
        // Prefer relation edges, then edges between higher-degree endpoints.
        const rk = (e: ConstellationGraphEdge) => (e.kind === 'relation' ? 1 : 0);
        return rk(y) - rk(x) ||
          ((deg.get(y.a) ?? 0) + (deg.get(y.b) ?? 0)) - ((deg.get(x.a) ?? 0) + (deg.get(x.b) ?? 0));
      })
      .slice(0, GRAPH_MAX_EDGES);
  }

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingConstellations,
      unresolvedRelations,
      duplicateEdges,
      capped,
    },
    statsBySource: Object.fromEntries(perSource),
  };
}

export interface ReviewQueueItem {
  concept: Concept;
  source_id: number;
  source_title: string | null;
  source_filename: string;
  compression_stage: number;
  last_reviewed_at: string | null;
  attempts: number;
  // SRS (migration 0025). due_at null = never scheduled (brand new, due now);
  // interval_days is the current spacing, 0 for a fresh card.
  due_at: string | null;
  interval_days: number;
}

interface ReviewQueueRow {
  id: number | bigint;
  source_id: number | bigint;
  name: string;
  slug: string;
  importance: string;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string;
  chunk_ids: string;
  section_path: string;
  exam_value: number;
  misconception_risk: number;
  centrality_score: number;
  created_at: string;
  source_title: string | null;
  source_filename: string;
  compression_stage: number | null;
  last_reviewed_at: string | null;
  attempts: number | null;
  due_at: string | null;
  interval_days: number | null;
}

// The review queue is SRS-driven (migration 0025) and shows ALL promoted
// concepts with their due state, rather than hiding scheduled ones: each row
// carries `due_at` so the UI renders a due badge (new / due now / overdue Nd /
// due in Nd). Snoozing or grading a concept therefore keeps it visible with an
// updated badge instead of removing it. Ordering surfaces what needs attention:
// brand-new first, then by due date ascending (most-overdue → due → soonest
// future), then the prior centrality/importance/recency tiebreakers. The
// due-now subset is exposed separately via countDueConcepts. datetime()
// normalizes both the ISO-UTC timestamps written at grade time and the
// migration's 'YYYY-MM-DD HH:MM:SS' backfill values.
export function listReviewQueue(db: DatabaseSync, limit = 50): ReviewQueueItem[] {
  const rows = db
    .prepare(
      `SELECT c.*,
              s.title    AS source_title,
              s.filename AS source_filename,
              COALESCE(m.compression_stage, 0) AS compression_stage,
              r.last_reviewed_at,
              COALESCE(r.attempts, 0) AS attempts,
              srs.due_at AS due_at,
              srs.interval_days AS interval_days
       FROM concepts c
       JOIN sources s ON s.id = c.source_id
       LEFT JOIN mastery m ON m.concept_id = c.id
       LEFT JOIN concept_srs srs ON srs.concept_id = c.id
       LEFT JOIN (
         SELECT concept_id,
                MAX(created_at) AS last_reviewed_at,
                COUNT(*)        AS attempts
         FROM evidence_records
         GROUP BY concept_id
       ) r ON r.concept_id = c.id
       ORDER BY
         CASE WHEN srs.due_at IS NULL THEN 0 ELSE 1 END,
         datetime(srs.due_at) ASC,
         c.centrality_score DESC,
         CASE c.importance
           WHEN 'foundational' THEN 0
           WHEN 'core' THEN 1
           WHEN 'supporting' THEN 2
           WHEN 'peripheral' THEN 3
           ELSE 4 END,
         c.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as ReviewQueueRow[];

  return rows.map(row => ({
    concept: rowToConcept(row),
    source_id: Number(row.source_id),
    source_title: row.source_title,
    source_filename: row.source_filename,
    compression_stage: row.compression_stage ?? 0,
    last_reviewed_at: row.last_reviewed_at,
    attempts: row.attempts ?? 0,
    due_at: row.due_at,
    interval_days: row.interval_days ?? 0,
  }));
}

// Mark a concept as reviewed (removes it from the review queue) or clear the
// flag (restores it). Idempotent.
export function setConceptReviewed(db: DatabaseSync, conceptId: number, reviewed: boolean): void {
  db.prepare('UPDATE concepts SET reviewed_at = ? WHERE id = ?')
    .run(reviewed ? new Date().toISOString() : null, conceptId);
}

// ─── Evidence aggregator (for source-viewer pane) ────────────────────────────

export type SourceEvidenceKind = 'chunk' | 'equation' | 'relation' | 'heading' | 'definition' | 'first_page' | 'highlight';

export interface SourceEvidence {
  // Stable position in the concept's evidence_json store (-1 = synthetic
  // first-page fallback, not editable). Used by the UI for edit/delete.
  index: number;
  page: number;
  kind: SourceEvidenceKind;
  label: string;
  quote?: string;
  // For highlight-backed evidence: the source annotation id. Lets the UI render
  // the exact highlight color (and survive description edits / recoloring).
  annotationId?: number;
}

interface EvidenceSpan {
  source: string;
  quote?: string;
  page: number;
  pattern?: string;
  kind?: SourceEvidenceKind;
  label?: string;
  annotationId?: number;
}

function deriveEvidenceKind(source: string): SourceEvidenceKind {
  return source === 'heading' ? 'heading'
    : source === 'definition_pattern' ? 'definition'
    : source === 'equation' ? 'equation'
    : source === 'relation' ? 'relation'
    : source === 'first_page' ? 'first_page'
    : source === 'highlight' ? 'highlight'
    : 'chunk';
}

function evidenceKindToSource(kind: SourceEvidenceKind): string {
  return kind === 'definition' ? 'definition_pattern' : kind;
}

function parseEvidenceSpans(json: string | undefined | null): EvidenceSpan[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as EvidenceSpan[]) : [];
  } catch { return []; }
}

function spanToEvidence(s: EvidenceSpan, index: number): SourceEvidence {
  return {
    index,
    page: s.page,
    kind: s.kind ?? deriveEvidenceKind(s.source),
    label: s.label ?? (s.source ? s.source.replace(/_/g, ' ') : 'evidence'),
    quote: s.quote,
    annotationId: s.annotationId,
  };
}

export interface ConceptSourceEvidence {
  sourceId: number;
  filePath: string;
  filename: string;
  pageCount: number | null;
  isPdf: boolean;
  evidence: SourceEvidence[];
}

export function listConceptSourceEvidence(db: DatabaseSync, conceptId: number): ConceptSourceEvidence | null {
  const c = db
    .prepare('SELECT * FROM concepts WHERE id = ?')
    .get(conceptId) as ConceptRow | undefined;
  if (!c) return null;
  const sourceId = Number(c.source_id);
  const src = db
    .prepare('SELECT file_path, filename, page_count FROM sources WHERE id = ?')
    .get(sourceId) as { file_path: string; filename: string; page_count: number | null } | undefined;
  if (!src) return null;

  const concept = rowToConcept(c);
  let spans = parseEvidenceSpans(c.evidence_json);

  // Seed once from derived sources (chunks / equations / relations / matching
  // candidate) when the concept has no stored evidence yet. Thereafter
  // evidence_json is the authoritative, user-editable store.
  if (spans.length === 0) {
    spans = buildDerivedEvidenceSpans(db, concept, sourceId);
    if (spans.length > 0) {
      db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?')
        .run(JSON.stringify(spans), conceptId);
    }
  }

  let evidence: SourceEvidence[] = spans.map(spanToEvidence);
  if (evidence.length === 0) {
    evidence = [{ index: -1, page: 1, kind: 'first_page', label: 'first page' }];
  }
  // Sort by page for display; the stable `index` keeps edit/delete aligned to
  // storage order regardless of display order.
  evidence.sort((a, b) => a.page - b.page || a.kind.localeCompare(b.kind));

  return {
    sourceId,
    filePath: src.file_path,
    filename: src.filename,
    pageCount: src.page_count,
    isPdf: src.file_path.toLowerCase().endsWith('.pdf'),
    evidence,
  };
}

// Aggregate evidence from derived sources. Used only to seed evidence_json the
// first time; after that the stored spans are authoritative.
function buildDerivedEvidenceSpans(db: DatabaseSync, concept: Concept, sourceId: number): EvidenceSpan[] {
  const spans: EvidenceSpan[] = [];

  if (concept.chunk_ids.length > 0) {
    const placeholders = concept.chunk_ids.map(() => '?').join(',');
    const chunkRows = db
      .prepare(`SELECT id, page_start, page_end, block_type, claim, example_quote
                FROM semantic_chunks WHERE id IN (${placeholders})
                ORDER BY page_start`)
      .all(...concept.chunk_ids) as Array<{
        id: number | bigint; page_start: number; page_end: number;
        block_type: string; claim: string | null; example_quote: string | null;
      }>;
    for (const r of chunkRows) {
      for (let p = r.page_start; p <= r.page_end; p++) {
        spans.push({ source: 'chunk', kind: 'chunk', label: r.block_type, quote: r.claim ?? r.example_quote ?? undefined, page: p });
      }
    }
  }

  const normalizedName = concept.name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
  const equations = db
    .prepare('SELECT page, latex FROM equation_candidates WHERE source_id = ? AND attached_term = ? ORDER BY page')
    .all(sourceId, normalizedName) as Array<{ page: number; latex: string }>;
  for (const eq of equations) {
    spans.push({ source: 'equation', kind: 'equation', label: 'equation', quote: eq.latex, page: eq.page });
  }

  const relations = db
    .prepare(
      `SELECT page, from_term, to_term, relation_kind, quote
       FROM relation_candidates
       WHERE source_id = ? AND (LOWER(from_term) = ? OR LOWER(to_term) = ?)
       ORDER BY page`,
    )
    .all(sourceId, concept.name.toLowerCase(), concept.name.toLowerCase()) as Array<{
      page: number; from_term: string; to_term: string; relation_kind: string; quote: string;
    }>;
  for (const r of relations) {
    spans.push({ source: 'relation', kind: 'relation', label: `${r.from_term} → ${r.relation_kind} → ${r.to_term}`, quote: r.quote, page: r.page });
  }

  const candidateRow = db
    .prepare('SELECT evidence FROM concept_candidates WHERE source_id = ? AND normalized = ? LIMIT 1')
    .get(sourceId, normalizedName) as { evidence: string } | undefined;
  if (candidateRow) {
    for (const s of parseEvidenceSpans(candidateRow.evidence)) {
      const kind = deriveEvidenceKind(s.source);
      spans.push({ source: s.source, kind, label: s.source.replace(/_/g, ' '), quote: s.quote, page: s.page });
    }
  }

  return spans;
}

// ── Evidence CRUD (evidence_json is authoritative once seeded) ──────────────
function seededSpans(db: DatabaseSync, conceptId: number, c: ConceptRow): EvidenceSpan[] {
  let spans = parseEvidenceSpans(c.evidence_json);
  if (spans.length === 0) spans = buildDerivedEvidenceSpans(db, rowToConcept(c), Number(c.source_id));
  return spans;
}

export function addConceptEvidence(
  db: DatabaseSync,
  conceptId: number,
  item: { page: number; kind: SourceEvidenceKind; label: string; quote?: string; annotationId?: number },
): ConceptSourceEvidence | null {
  const c = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as ConceptRow | undefined;
  if (!c) return null;
  const spans = seededSpans(db, conceptId, c);
  spans.push({ source: evidenceKindToSource(item.kind), kind: item.kind, label: item.label, quote: item.quote, page: item.page, annotationId: item.annotationId });
  db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?').run(JSON.stringify(spans), conceptId);
  return listConceptSourceEvidence(db, conceptId);
}

export function updateConceptEvidence(
  db: DatabaseSync,
  conceptId: number,
  index: number,
  fields: { page?: number; kind?: SourceEvidenceKind; label?: string; quote?: string },
): ConceptSourceEvidence | null {
  const c = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as ConceptRow | undefined;
  if (!c) return null;
  const spans = seededSpans(db, conceptId, c);
  if (index < 0 || index >= spans.length) return listConceptSourceEvidence(db, conceptId);
  const cur = spans[index];
  spans[index] = {
    ...cur,
    page: fields.page ?? cur.page,
    quote: fields.quote !== undefined ? fields.quote : cur.quote,
    kind: fields.kind ?? cur.kind ?? deriveEvidenceKind(cur.source),
    label: fields.label ?? cur.label,
    source: fields.kind ? evidenceKindToSource(fields.kind) : cur.source,
  };
  db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?').run(JSON.stringify(spans), conceptId);
  return listConceptSourceEvidence(db, conceptId);
}

export function deleteConceptEvidenceByIndex(db: DatabaseSync, conceptId: number, index: number): ConceptSourceEvidence | null {
  const c = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as ConceptRow | undefined;
  if (!c) return null;
  const spans = seededSpans(db, conceptId, c);
  if (index >= 0 && index < spans.length) {
    spans.splice(index, 1);
    db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?').run(JSON.stringify(spans), conceptId);
  }
  return listConceptSourceEvidence(db, conceptId);
}

export function listRequirementsFor(db: DatabaseSync, conceptId: number): Concept[] {
  return (
    db
      .prepare(
        `SELECT c.* FROM concepts c
         JOIN concept_edges e ON e.from_id = c.id
         WHERE e.to_id = ? AND e.edge_type = 'requires'`,
      )
      .all(conceptId) as unknown as ConceptRow[]
  ).map(rowToConcept);
}
