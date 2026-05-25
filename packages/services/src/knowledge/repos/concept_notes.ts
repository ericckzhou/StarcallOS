import type { DatabaseSync } from '../../core/infra/sqlite';
import type { ConceptNote } from '../../core/domain/types';

interface ConceptNoteRow {
  id: number | bigint;
  concept_id: number | bigint;
  position: number;
  heading: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: ConceptNoteRow): ConceptNote {
  return {
    id: Number(row.id),
    concept_id: Number(row.concept_id),
    position: row.position,
    heading: row.heading,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listNotesByConcept(db: DatabaseSync, conceptId: number): ConceptNote[] {
  return (
    db
      .prepare('SELECT * FROM concept_notes WHERE concept_id = ? ORDER BY position, id')
      .all(conceptId) as unknown as ConceptNoteRow[]
  ).map(rowToNote);
}

export function createNote(
  db: DatabaseSync,
  conceptId: number,
  input: { heading: string; body?: string },
): ConceptNote {
  const heading = input.heading.trim() || 'Untitled note';
  const body    = input.body ?? '';
  const next = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM concept_notes WHERE concept_id = ?')
    .get(conceptId) as { next: number };
  const result = db
    .prepare(
      `INSERT INTO concept_notes (concept_id, position, heading, body)
       VALUES (?, ?, ?, ?)`,
    )
    .run(conceptId, next.next, heading, body);
  const row = db
    .prepare('SELECT * FROM concept_notes WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as ConceptNoteRow;
  return rowToNote(row);
}

export function updateNote(
  db: DatabaseSync,
  id: number,
  patch: { heading?: string; body?: string },
): ConceptNote | null {
  const existing = db
    .prepare('SELECT * FROM concept_notes WHERE id = ?')
    .get(id) as ConceptNoteRow | undefined;
  if (!existing) return null;

  const heading = patch.heading !== undefined
    ? (patch.heading.trim() || 'Untitled note')
    : existing.heading;
  const body = patch.body !== undefined ? patch.body : existing.body;

  db.prepare(
    `UPDATE concept_notes
       SET heading = ?, body = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(heading, body, id);

  const row = db
    .prepare('SELECT * FROM concept_notes WHERE id = ?')
    .get(id) as unknown as ConceptNoteRow;
  return rowToNote(row);
}

export function deleteNote(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM concept_notes WHERE id = ?').run(id);
}

// Apply a new ordering for all notes on a concept. Atomic — rejects any
// id that doesn't belong to this concept rather than partially writing.
export function reorderNotes(
  db: DatabaseSync,
  conceptId: number,
  orderedIds: number[],
): ConceptNote[] {
  const owned = (db
    .prepare('SELECT id FROM concept_notes WHERE concept_id = ?')
    .all(conceptId) as Array<{ id: number | bigint }>).map(r => Number(r.id));
  const ownedSet = new Set(owned);
  for (const id of orderedIds) {
    if (!ownedSet.has(id)) {
      throw new Error(`note ${id} does not belong to concept ${conceptId}`);
    }
  }
  if (orderedIds.length !== owned.length) {
    throw new Error(`reorder expects all ${owned.length} notes, got ${orderedIds.length}`);
  }

  db.exec('BEGIN');
  try {
    const stmt = db.prepare('UPDATE concept_notes SET position = ? WHERE id = ?');
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listNotesByConcept(db, conceptId);
}
