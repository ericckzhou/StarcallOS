import type { DatabaseSync } from './core/infra/sqlite';

export type EventType =
  | 'concept.created'
  | 'attempt.submitted'
  | 'attempt.graded';

export interface AppEvent {
  id: number;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
}

interface EventRow {
  id: number | bigint;
  type: string;
  payload: string;
  created_at: string;
}

export function emitEvent(
  db: DatabaseSync,
  type: EventType,
  payload: Record<string, unknown>,
): number {
  const result = db
    .prepare('INSERT INTO events (type, payload) VALUES (?, ?)')
    .run(type, JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

export function queryEvents(db: DatabaseSync): AppEvent[] {
  return (
    db.prepare('SELECT * FROM events ORDER BY id').all() as EventRow[]
  ).map(row => ({
    id: Number(row.id),
    type: row.type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}
