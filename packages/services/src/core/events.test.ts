import { describe, expect, it } from 'vitest';
import { openDb } from './infra/db';
import { emitEvent, queryEvents } from './events';

describe('events ledger', () => {
  it('returns the new row id and links entity type/id when provided', () => {
    const db = openDb(':memory:');

    const id = emitEvent(db, 'source.created', { filename: 'b.pdf' }, { entityType: 'source', entityId: 42 });

    expect(typeof id).toBe('number');
    const events = queryEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe('source');
    expect(events[0].entityId).toBe(42);
    db.close();
  });

  it('defaults entity type/id to null when no options are given', () => {
    const db = openDb(':memory:');

    emitEvent(db, 'concept.created', { slug: 'x' });

    const [event] = queryEvents(db);
    expect(event.entityType).toBeNull();
    expect(event.entityId).toBeNull();
    expect(typeof event.created_at).toBe('string');
    db.close();
  });

  it('round-trips a nested JSON payload', () => {
    const db = openDb(':memory:');

    emitEvent(db, 'evidence_record.graded', {
      score: 0.8,
      gaps: ['compression', 'transfer'],
      meta: { stage: 2, ok: true },
    });

    const [event] = queryEvents(db);
    expect(event.payload).toEqual({
      score: 0.8,
      gaps: ['compression', 'transfer'],
      meta: { stage: 2, ok: true },
    });
    db.close();
  });

  it('orders events by ascending id (append-only)', () => {
    const db = openDb(':memory:');

    emitEvent(db, 'source.created', { n: 1 });
    emitEvent(db, 'source.processing_started', { n: 2 });
    emitEvent(db, 'source.processing_completed', { n: 3 });

    const events = queryEvents(db);
    expect(events.map(e => e.payload['n'])).toEqual([1, 2, 3]);
    expect(events.map(e => e.id)).toEqual([1, 2, 3]);
    db.close();
  });
});
