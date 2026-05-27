import type { DatabaseSync } from './infra/sqlite';

export type EventType =
  | 'source.created'
  | 'source.processing_started'
  | 'source.processing_completed'
  | 'source.processing_failed'
  | 'source.processing_interrupted'
  | 'source.retry_started'
  | 'source.retry_completed'
  | 'concept.created'
  | 'concept.promoted_from_candidate'
  | 'concept_candidate.rejected'
  | 'misconception.detected'
  | 'misconception.resolved'
  | 'evidence_record.submitted'
  | 'evidence_record.graded'
  | 'mastery.updated'
  | 'pdf_annotation.created'
  | 'pdf_annotation.updated'
  | 'pdf_annotation.deleted'
  | 'pdf_annotation.restored';

export interface AppEvent {
  id: number;
  type: EventType;
  entityType: string | null;
  entityId: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

interface EventRow {
  id: number | bigint;
  type: string;
  entity_type: string | null;
  entity_id: number | bigint | null;
  payload: string;
  created_at: string;
}

interface EmitOptions {
  entityType?: string;
  entityId?: number;
}

export function emitEvent(
  db: DatabaseSync,
  type: EventType,
  payload: Record<string, unknown>,
  options?: EmitOptions,
): number {
  const result = db
    .prepare(
      'INSERT INTO events (type, entity_type, entity_id, payload) VALUES (?, ?, ?, ?)',
    )
    .run(
      type,
      options?.entityType ?? null,
      options?.entityId ?? null,
      JSON.stringify(payload),
    );
  return Number(result.lastInsertRowid);
}

export function queryEvents(db: DatabaseSync): AppEvent[] {
  return (
    db.prepare('SELECT * FROM events ORDER BY id').all() as unknown as EventRow[]
  ).map(row => ({
    id: Number(row.id),
    type: row.type as EventType,
    entityType: row.entity_type,
    entityId: row.entity_id != null ? Number(row.entity_id) : null,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}
