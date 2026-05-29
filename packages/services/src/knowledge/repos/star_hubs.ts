import type { DatabaseSync } from '../../core/infra/sqlite';

// Star Hubs: named, color-coded groups of concepts (cross-source). User-curated;
// never written by an LLM pass or by re-extraction.

export interface StarHub {
  id: number;
  name: string;
  description: string;
  color: string;
  type: string;
  importance: string;
  parent_hub_id: number | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface StarHubMember {
  concept_id: number;
  name: string;
  source_id: number;
  source_filename?: string;
  importance: string;
  role: string;
  order_index: number;
}

interface HubRow {
  id: number | bigint;
  name: string;
  description: string;
  color: string;
  type: string;
  importance: string;
  parent_hub_id: number | bigint | null;
  created_at: string;
  updated_at: string;
  member_count: number;
}

function rowToHub(row: HubRow): StarHub {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    color: row.color,
    type: row.type,
    importance: row.importance,
    parent_hub_id: row.parent_hub_id == null ? null : Number(row.parent_hub_id),
    member_count: Number(row.member_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const HUB_SELECT = `
  SELECT h.*, (SELECT COUNT(*) FROM star_hub_members m WHERE m.hub_id = h.id) AS member_count
    FROM star_hubs h`;

export function listHubs(db: DatabaseSync): StarHub[] {
  return (db.prepare(`${HUB_SELECT} ORDER BY h.name`).all() as unknown as HubRow[]).map(rowToHub);
}

export function getHub(db: DatabaseSync, id: number): StarHub | null {
  const row = db.prepare(`${HUB_SELECT} WHERE h.id = ?`).get(id) as HubRow | undefined;
  return row ? rowToHub(row) : null;
}

export function createHub(
  db: DatabaseSync,
  input: { name: string; color?: string; description?: string; conceptIds?: number[] },
): StarHub {
  const name = input.name.trim() || 'Untitled hub';
  const result = db
    .prepare('INSERT INTO star_hubs (name, color, description) VALUES (?, ?, ?)')
    .run(name, input.color ?? '#818cf8', input.description ?? '');
  const hubId = Number(result.lastInsertRowid);
  if (input.conceptIds?.length) addMembers(db, hubId, input.conceptIds);
  return getHub(db, hubId)!;
}

export function updateHub(
  db: DatabaseSync,
  id: number,
  patch: { name?: string; color?: string; description?: string },
): StarHub | null {
  const existing = getHub(db, id);
  if (!existing) return null;
  const name = patch.name !== undefined ? (patch.name.trim() || existing.name) : existing.name;
  const color = patch.color ?? existing.color;
  const description = patch.description ?? existing.description;
  db.prepare(
    `UPDATE star_hubs SET name = ?, color = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(name, color, description, id);
  return getHub(db, id);
}

export function deleteHub(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM star_hubs WHERE id = ?').run(id);
}

// Add concepts to a hub (idempotent — ignores already-present members). Appends
// at the end of the current member order.
export function addMembers(db: DatabaseSync, hubId: number, conceptIds: number[]): void {
  if (conceptIds.length === 0) return;
  const start = (db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM star_hub_members WHERE hub_id = ?')
    .get(hubId) as { next: number }).next;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO star_hub_members (hub_id, concept_id, role, order_index) VALUES (?, ?, 'core', ?)`,
  );
  db.exec('BEGIN');
  try {
    conceptIds.forEach((cid, i) => stmt.run(hubId, cid, start + i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function removeMember(db: DatabaseSync, hubId: number, conceptId: number): void {
  db.prepare('DELETE FROM star_hub_members WHERE hub_id = ? AND concept_id = ?').run(hubId, conceptId);
}

export function listHubMembers(db: DatabaseSync, hubId: number): StarHubMember[] {
  return (db
    .prepare(
      `SELECT m.concept_id, m.role, m.order_index, c.name, c.source_id, c.importance, s.filename AS source_filename
         FROM star_hub_members m
         JOIN concepts c ON c.id = m.concept_id
         LEFT JOIN sources s ON s.id = c.source_id
        WHERE m.hub_id = ?
        ORDER BY m.order_index, c.name`,
    )
    .all(hubId) as Array<{ concept_id: number | bigint; role: string; order_index: number; name: string; source_id: number | bigint; importance: string; source_filename: string | null }>)
    .map(r => ({
      concept_id: Number(r.concept_id),
      name: r.name,
      source_id: Number(r.source_id),
      source_filename: r.source_filename ?? undefined,
      importance: r.importance,
      role: r.role,
      order_index: r.order_index,
    }));
}

// Hubs that a concept belongs to (for chips). Lightweight: id/name/color only.
export function listHubsForConcept(db: DatabaseSync, conceptId: number): Array<{ id: number; name: string; color: string }> {
  return (db
    .prepare(
      `SELECT h.id, h.name, h.color
         FROM star_hub_members m JOIN star_hubs h ON h.id = m.hub_id
        WHERE m.concept_id = ? ORDER BY h.name`,
    )
    .all(conceptId) as Array<{ id: number | bigint; name: string; color: string }>)
    .map(r => ({ id: Number(r.id), name: r.name, color: r.color }));
}

// All (hub_id, concept_id) memberships — lets the renderer build per-concept
// chips for a whole source in one round trip.
export function listAllMemberships(db: DatabaseSync): Array<{ hub_id: number; concept_id: number }> {
  return (db
    .prepare('SELECT hub_id, concept_id FROM star_hub_members')
    .all() as Array<{ hub_id: number | bigint; concept_id: number | bigint }>)
    .map(r => ({ hub_id: Number(r.hub_id), concept_id: Number(r.concept_id) }));
}
