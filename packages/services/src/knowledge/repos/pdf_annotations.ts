import type { DatabaseSync } from '../../core/infra/sqlite';
import type {
  PdfAnnotation,
  PdfAnnotationProvenance,
  PdfAnnotationRect,
  PdfAnnotationScope,
  PdfAnnotationType,
} from '../../core/domain/types';

interface PdfAnnotationRow {
  id: number | bigint;
  source_id: number | bigint;
  concept_id: number | bigint | null;
  scope: string;
  type: string;
  created_from: string;
  page: number;
  color: string;
  selected_text: string;
  label: string;
  note_body: string;
  rects_json: string;
  page_width: number | null;
  page_height: number | null;
  rotation: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreatePdfAnnotationInput {
  sourceId: number;
  conceptId?: number | null;
  scope?: PdfAnnotationScope;
  type: PdfAnnotationType;
  createdFrom: PdfAnnotationProvenance;
  page: number;
  color?: string;
  selectedText?: string;
  label?: string;
  noteBody?: string;
  rects: PdfAnnotationRect[];
  pageWidth?: number | null;
  pageHeight?: number | null;
  rotation?: number | null;
}

export interface UpdatePdfAnnotationInput {
  label?: string;
  noteBody?: string;
  color?: string;
  rects?: PdfAnnotationRect[];
  pageWidth?: number | null;
  pageHeight?: number | null;
  rotation?: number | null;
}

function rowToAnnotation(row: PdfAnnotationRow): PdfAnnotation {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    concept_id: row.concept_id == null ? null : Number(row.concept_id),
    scope: row.scope as PdfAnnotationScope,
    type: row.type as PdfAnnotationType,
    created_from: row.created_from as PdfAnnotationProvenance,
    page: row.page,
    color: row.color,
    selected_text: row.selected_text,
    label: row.label,
    note_body: row.note_body,
    rects: JSON.parse(row.rects_json) as PdfAnnotationRect[],
    page_width: row.page_width,
    page_height: row.page_height,
    rotation: row.rotation,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function getAnnotation(db: DatabaseSync, id: number): PdfAnnotation | null {
  const row = db
    .prepare('SELECT * FROM pdf_annotations WHERE id = ?')
    .get(id) as PdfAnnotationRow | undefined;
  return row ? rowToAnnotation(row) : null;
}

function sanitizeRects(rects: PdfAnnotationRect[]): PdfAnnotationRect[] {
  return rects
    .map(r => ({
      x: clampAnnotationPosition(r.x),
      y: clampAnnotationPosition(r.y),
      width: clamp01(r.width),
      height: clamp01(r.height),
    }))
    .filter(r => r.width > 0 && r.height > 0);
}

function clampAnnotationPosition(value: number): number {
  return Number.isFinite(value) ? Math.max(-2, Math.min(3, value)) : 0;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function listPdfAnnotationsBySource(
  db: DatabaseSync,
  sourceId: number,
  includeDeleted = false,
): PdfAnnotation[] {
  const sql = includeDeleted
    ? 'SELECT * FROM pdf_annotations WHERE source_id = ? ORDER BY page, id'
    : 'SELECT * FROM pdf_annotations WHERE source_id = ? AND deleted_at IS NULL ORDER BY page, id';
  return (db.prepare(sql).all(sourceId) as unknown as PdfAnnotationRow[]).map(rowToAnnotation);
}

export function createPdfAnnotation(
  db: DatabaseSync,
  input: CreatePdfAnnotationInput,
): PdfAnnotation {
  const rects = sanitizeRects(input.rects);
  if (rects.length === 0) throw new Error('pdf annotation requires at least one rectangle');
  const scope = input.scope ?? 'source';
  const color = input.color?.trim() || (input.type === 'note' ? '#f59e0b' : '#facc15');
  const result = db
    .prepare(
      `INSERT INTO pdf_annotations
       (source_id, concept_id, scope, type, created_from, page, color, selected_text, label,
        note_body, rects_json, page_width, page_height, rotation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sourceId,
      input.conceptId ?? null,
      scope,
      input.type,
      input.createdFrom,
      Math.max(1, Math.floor(input.page)),
      color,
      input.selectedText ?? '',
      input.label ?? '',
      input.noteBody ?? '',
      JSON.stringify(rects),
      input.pageWidth ?? null,
      input.pageHeight ?? null,
      input.rotation ?? null,
    );
  const created = getAnnotation(db, Number(result.lastInsertRowid));
  if (!created) throw new Error('failed to create pdf annotation');
  return created;
}

export function updatePdfAnnotation(
  db: DatabaseSync,
  id: number,
  patch: UpdatePdfAnnotationInput,
): PdfAnnotation | null {
  const existing = getAnnotation(db, id);
  if (!existing) return null;
  const rects = patch.rects !== undefined ? sanitizeRects(patch.rects) : existing.rects;
  if (rects.length === 0) throw new Error('pdf annotation requires at least one rectangle');
  db.prepare(
    `UPDATE pdf_annotations
        SET label = ?,
            note_body = ?,
            color = ?,
            rects_json = ?,
            page_width = ?,
            page_height = ?,
            rotation = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(
    patch.label !== undefined ? patch.label : existing.label,
    patch.noteBody !== undefined ? patch.noteBody : existing.note_body,
    patch.color !== undefined ? patch.color : existing.color,
    JSON.stringify(rects),
    patch.pageWidth !== undefined ? patch.pageWidth : existing.page_width,
    patch.pageHeight !== undefined ? patch.pageHeight : existing.page_height,
    patch.rotation !== undefined ? patch.rotation : existing.rotation,
    id,
  );
  return getAnnotation(db, id);
}

export function softDeletePdfAnnotation(db: DatabaseSync, id: number): PdfAnnotation | null {
  db.prepare(
    `UPDATE pdf_annotations
        SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(id);
  return getAnnotation(db, id);
}

export function restorePdfAnnotation(db: DatabaseSync, id: number): PdfAnnotation | null {
  db.prepare(
    `UPDATE pdf_annotations
        SET deleted_at = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(id);
  return getAnnotation(db, id);
}

// ─── Read-only highlight lookup (used by the MCP reader) ─────────────────────
// Only persisted, live (`deleted_at IS NULL`) rows of type `highlight`; sticky
// notes (`type = 'note'`) are a different thing and are not returned.

export interface HighlightHit {
  annotation: PdfAnnotation;
  source_title: string;
  concept_name: string | null;
}

interface HighlightJoinRow extends PdfAnnotationRow {
  source_title: string;
  concept_name: string | null;
}

const HIGHLIGHT_SELECT = `
  SELECT a.*, COALESCE(s.title, s.filename, '') AS source_title, c.name AS concept_name
    FROM pdf_annotations a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN concepts c ON c.id = a.concept_id
   WHERE a.type = 'highlight' AND a.deleted_at IS NULL`;

function toHighlightHit(r: HighlightJoinRow): HighlightHit {
  return { annotation: rowToAnnotation(r), source_title: r.source_title, concept_name: r.concept_name ?? null };
}

export function getHighlight(db: DatabaseSync, id: number): HighlightHit | null {
  const r = db.prepare(`${HIGHLIGHT_SELECT} AND a.id = ?`).get(id) as HighlightJoinRow | undefined;
  return r ? toHighlightHit(r) : null;
}

// Every query word must appear in the highlighted text, its label, its note,
// or the linked concept's name. An empty query lists the newest highlights.
export function searchHighlights(db: DatabaseSync, query: string, limit = 10): HighlightHit[] {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length >= 2).slice(0, 8);
  const like = (t: string) => `%${t.replace(/[\\%_]/g, c => '\\' + c)}%`;
  const clause = words.map(() =>
    `AND (lower(a.selected_text) LIKE ? ESCAPE '\\' OR lower(a.label) LIKE ? ESCAPE '\\'
          OR lower(a.note_body) LIKE ? ESCAPE '\\' OR lower(COALESCE(c.name, '')) LIKE ? ESCAPE '\\')`,
  ).join(' ');
  const args = words.flatMap(w => [like(w), like(w), like(w), like(w)]);
  const rows = db.prepare(`${HIGHLIGHT_SELECT} ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .all(...args, limit) as unknown as HighlightJoinRow[];
  return rows.map(toHighlightHit);
}
