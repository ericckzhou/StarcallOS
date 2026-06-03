import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept } from './concepts';
import {
  listHubs,
  getHub,
  createHub,
  updateHub,
  deleteHub,
  addMembers,
  removeMember,
  listHubMembers,
  listHubsForConcept,
  listAllMemberships,
  listHubEdges,
  createHubEdge,
  updateHubEdge,
  deleteHubEdge,
} from './star_hubs';

type DB = ReturnType<typeof openDb>;

let conceptSeq = 0;
function makeConcept(db: DB, sourceId: number, name = `Concept ${++conceptSeq}`) {
  return createConcept(db, {
    source_id: sourceId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    importance: 'core',
    definition_text: '',
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0.5,
    misconception_risk: 0.2,
    centrality_score: 0,
  });
}

function setup() {
  conceptSeq = 0;
  const db = openDb(':memory:');
  const srcA = createSource(db, { filename: 'a.pdf', file_path: '/tmp/a.pdf' });
  const srcB = createSource(db, { filename: 'b.pdf', file_path: '/tmp/b.pdf' });
  const c1 = makeConcept(db, srcA.id, 'Alpha');
  const c2 = makeConcept(db, srcA.id, 'Beta');
  const c3 = makeConcept(db, srcB.id, 'Gamma');
  return { db, srcA, srcB, c1, c2, c3 };
}

describe('createHub / getHub / listHubs', () => {
  let db: DB;
  beforeEach(() => { ({ db } = setup()); });

  it('creates a hub with defaults and reads it back', () => {
    const hub = createHub(db, { name: 'Optimization' });
    expect(hub.name).toBe('Optimization');
    expect(hub.color).toBe('#818cf8');
    expect(hub.description).toBe('');
    expect(hub.member_count).toBe(0);
    expect(getHub(db, hub.id)).toEqual(hub);
  });

  it('trims the name and falls back to "Untitled hub" when blank', () => {
    expect(createHub(db, { name: '  Spaced  ' }).name).toBe('Spaced');
    expect(createHub(db, { name: '   ' }).name).toBe('Untitled hub');
  });

  it('honors a provided color and description', () => {
    const hub = createHub(db, { name: 'Custom', color: '#ff0000', description: 'red group' });
    expect(hub.color).toBe('#ff0000');
    expect(hub.description).toBe('red group');
  });

  it('returns null for a missing hub', () => {
    expect(getHub(db, 12345)).toBeNull();
  });

  it('lists hubs alphabetically by name', () => {
    createHub(db, { name: 'Zeta' });
    createHub(db, { name: 'Alpha' });
    createHub(db, { name: 'Mu' });
    expect(listHubs(db).map(h => h.name)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });
});

describe('createHub with members', () => {
  it('seeds members from conceptIds and counts them', () => {
    const { db, c1, c2 } = setup();
    const hub = createHub(db, { name: 'Seeded', conceptIds: [c1.id, c2.id] });
    expect(hub.member_count).toBe(2);
    expect(listHubMembers(db, hub.id).map(m => m.concept_id).sort()).toEqual([c1.id, c2.id].sort());
  });
});

describe('updateHub', () => {
  let db: DB;
  beforeEach(() => { ({ db } = setup()); });

  it('patches only provided fields and preserves the rest', () => {
    const hub = createHub(db, { name: 'Old', color: '#111111', description: 'desc' });
    const updated = updateHub(db, hub.id, { color: '#222222' });
    expect(updated!.name).toBe('Old');
    expect(updated!.color).toBe('#222222');
    expect(updated!.description).toBe('desc');
  });

  it('keeps the existing name when the patch name is blank', () => {
    const hub = createHub(db, { name: 'Keep' });
    expect(updateHub(db, hub.id, { name: '   ' })!.name).toBe('Keep');
  });

  it('returns null for a missing hub', () => {
    expect(updateHub(db, 999, { name: 'x' })).toBeNull();
  });
});

describe('nesting (parent_hub_id)', () => {
  let db: DB;
  beforeEach(() => { ({ db } = setup()); });

  it('creates a hub under a parent', () => {
    const parent = createHub(db, { name: 'Parent' });
    const child = createHub(db, { name: 'Child', parentHubId: parent.id });
    expect(child.parent_hub_id).toBe(parent.id);
    expect(createHub(db, { name: 'Root' }).parent_hub_id).toBeNull();
  });

  it('sets and clears a parent via updateHub', () => {
    const parent = createHub(db, { name: 'Parent' });
    const child = createHub(db, { name: 'Child' });
    expect(updateHub(db, child.id, { parentHubId: parent.id })!.parent_hub_id).toBe(parent.id);
    expect(updateHub(db, child.id, { parentHubId: null })!.parent_hub_id).toBeNull();
  });

  it('leaves the parent unchanged when parentHubId is omitted from the patch', () => {
    const parent = createHub(db, { name: 'Parent' });
    const child = createHub(db, { name: 'Child', parentHubId: parent.id });
    expect(updateHub(db, child.id, { name: 'Renamed' })!.parent_hub_id).toBe(parent.id);
  });

  it('rejects nesting a hub under itself', () => {
    const hub = createHub(db, { name: 'Self' });
    expect(() => updateHub(db, hub.id, { parentHubId: hub.id })).toThrow(/itself or one of its descendants/);
  });

  it('rejects nesting a hub under one of its descendants (cycle)', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B', parentHubId: a.id });
    const c = createHub(db, { name: 'C', parentHubId: b.id });
    // A under C would form A→…→C→A.
    expect(() => updateHub(db, a.id, { parentHubId: c.id })).toThrow();
    // Unrelated re-parent is still allowed.
    expect(updateHub(db, c.id, { parentHubId: a.id })!.parent_hub_id).toBe(a.id);
  });

  it('re-roots children to null when their parent is deleted (ON DELETE SET NULL)', () => {
    const parent = createHub(db, { name: 'Parent' });
    const child = createHub(db, { name: 'Child', parentHubId: parent.id });
    deleteHub(db, parent.id);
    expect(getHub(db, child.id)!.parent_hub_id).toBeNull();
  });
});

describe('hub edges', () => {
  let db: DB;
  beforeEach(() => { ({ db } = setup()); });

  it('creates a labeled, directional edge between two hubs', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    const edge = createHubEdge(db, { aHubId: a.id, bHubId: b.id, label: 'feeds into', directed: true });
    expect(edge.a_hub_id).toBe(a.id);
    expect(edge.b_hub_id).toBe(b.id);
    expect(edge.label).toBe('feeds into');
    expect(edge.directed).toBe(true);
  });

  it('defaults to directed and an empty label', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    const edge = createHubEdge(db, { aHubId: a.id, bHubId: b.id });
    expect(edge.label).toBe('');
    expect(edge.directed).toBe(true);
  });

  it('supports a mutual (undirected) edge', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    expect(createHubEdge(db, { aHubId: a.id, bHubId: b.id, directed: false }).directed).toBe(false);
  });

  it('rejects a self-edge', () => {
    const a = createHub(db, { name: 'A' });
    expect(() => createHubEdge(db, { aHubId: a.id, bHubId: a.id })).toThrow(/cannot link to itself/i);
  });

  it('is idempotent on the ordered pair — re-adding returns the same row', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    const first = createHubEdge(db, { aHubId: a.id, bHubId: b.id, label: 'one' });
    const again = createHubEdge(db, { aHubId: a.id, bHubId: b.id, label: 'two' });
    expect(again.id).toBe(first.id);
    expect(listHubEdges(db)).toHaveLength(1);
  });

  it('treats a→b and b→a as distinct edges', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    createHubEdge(db, { aHubId: a.id, bHubId: b.id });
    createHubEdge(db, { aHubId: b.id, bHubId: a.id });
    expect(listHubEdges(db)).toHaveLength(2);
  });

  it('updates label and direction; returns null for a missing edge', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    const edge = createHubEdge(db, { aHubId: a.id, bHubId: b.id, label: 'old', directed: true });
    const updated = updateHubEdge(db, edge.id, { label: 'new', directed: false });
    expect(updated!.label).toBe('new');
    expect(updated!.directed).toBe(false);
    expect(updateHubEdge(db, 99999, { label: 'x' })).toBeNull();
  });

  it('deletes an edge', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    const edge = createHubEdge(db, { aHubId: a.id, bHubId: b.id });
    deleteHubEdge(db, edge.id);
    expect(listHubEdges(db)).toHaveLength(0);
  });

  it('cascades edges away when an endpoint hub is deleted', () => {
    const a = createHub(db, { name: 'A' });
    const b = createHub(db, { name: 'B' });
    createHubEdge(db, { aHubId: a.id, bHubId: b.id });
    deleteHub(db, a.id);
    expect(listHubEdges(db)).toHaveLength(0);
  });
});

describe('deleteHub', () => {
  it('removes the hub and cascades its members', () => {
    const { db, c1 } = setup();
    const hub = createHub(db, { name: 'Doomed', conceptIds: [c1.id] });
    deleteHub(db, hub.id);
    expect(getHub(db, hub.id)).toBeNull();
    expect(listAllMemberships(db)).toHaveLength(0);
  });
});

describe('addMembers', () => {
  it('is a no-op for an empty list', () => {
    const { db } = setup();
    const hub = createHub(db, { name: 'Empty' });
    addMembers(db, hub.id, []);
    expect(listHubMembers(db, hub.id)).toHaveLength(0);
  });

  it('appends members with increasing order_index', () => {
    const { db, c1, c2, c3 } = setup();
    const hub = createHub(db, { name: 'Ordered' });
    addMembers(db, hub.id, [c1.id, c2.id]);
    addMembers(db, hub.id, [c3.id]);
    const members = listHubMembers(db, hub.id);
    expect(members.map(m => m.concept_id)).toEqual([c1.id, c2.id, c3.id]);
    expect(members.map(m => m.order_index)).toEqual([0, 1, 2]);
  });

  it('is idempotent — re-adding an existing member does not duplicate', () => {
    const { db, c1 } = setup();
    const hub = createHub(db, { name: 'Idem' });
    addMembers(db, hub.id, [c1.id]);
    addMembers(db, hub.id, [c1.id]);
    expect(listHubMembers(db, hub.id)).toHaveLength(1);
  });
});

describe('removeMember', () => {
  it('removes a single membership without affecting others', () => {
    const { db, c1, c2 } = setup();
    const hub = createHub(db, { name: 'Trim', conceptIds: [c1.id, c2.id] });
    removeMember(db, hub.id, c1.id);
    expect(listHubMembers(db, hub.id).map(m => m.concept_id)).toEqual([c2.id]);
  });
});

describe('listHubMembers', () => {
  it('joins concept name, source id and filename', () => {
    const { db, srcA, c1 } = setup();
    const hub = createHub(db, { name: 'Joined', conceptIds: [c1.id] });
    const [member] = listHubMembers(db, hub.id);
    expect(member.name).toBe('Alpha');
    expect(member.source_id).toBe(srcA.id);
    expect(member.source_filename).toBe('a.pdf');
    expect(member.role).toBe('core');
  });
});

describe('listHubsForConcept', () => {
  it('lists every hub a concept belongs to, alphabetically', () => {
    const { db, c1 } = setup();
    const z = createHub(db, { name: 'Zeta', conceptIds: [c1.id] });
    const a = createHub(db, { name: 'Alpha', conceptIds: [c1.id] });
    createHub(db, { name: 'NotMine' });
    const hubs = listHubsForConcept(db, c1.id);
    expect(hubs.map(h => h.id)).toEqual([a.id, z.id]);
    expect(hubs[0]).toHaveProperty('color');
  });
});

describe('listAllMemberships', () => {
  it('returns every (hub_id, concept_id) pair across hubs', () => {
    const { db, c1, c2, c3 } = setup();
    const h1 = createHub(db, { name: 'H1', conceptIds: [c1.id, c2.id] });
    const h2 = createHub(db, { name: 'H2', conceptIds: [c3.id] });
    const all = listAllMemberships(db);
    expect(all).toHaveLength(3);
    expect(all).toContainEqual({ hub_id: h1.id, concept_id: c1.id });
    expect(all).toContainEqual({ hub_id: h1.id, concept_id: c2.id });
    expect(all).toContainEqual({ hub_id: h2.id, concept_id: c3.id });
  });
});
