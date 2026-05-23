import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { emitEvent, queryEvents } from '../events';

describe('Phase 0 smoke test', () => {
  it('opens in-memory DB, runs migrations, emits and queries an event', () => {
    const db = openDb(':memory:');
    const id = emitEvent(db, 'concept.created', { slug: 'attention', label: 'Attention' });
    expect(id).toBe(1);
    const events = queryEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('concept.created');
    expect(events[0].payload['slug']).toBe('attention');
    db.close();
  });
});
