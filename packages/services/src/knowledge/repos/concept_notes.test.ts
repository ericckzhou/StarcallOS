import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept } from './concepts';
import {
  createNote,
  listNotesByConcept,
  updateNote,
  deleteNote,
  reorderNotes,
} from './concept_notes';

function makeConcept(db: ReturnType<typeof openDb>, suffix = '') {
  const source = createSource(db, { filename: 'b.txt', file_path: 'b.txt' });
  return createConcept(db, {
    source_id: source.id,
    name: 'RAG' + suffix,
    slug: 'rag' + suffix.toLowerCase(),
    importance: 'core',
    definition_text: '',
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0,
    misconception_risk: 0,
    centrality_score: 0,
  });
}

describe('concept_notes repo', () => {
  it('creates notes with auto-incrementing position', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);

    const a = createNote(db, c.id, { heading: 'first' });
    const b = createNote(db, c.id, { heading: 'second' });
    const cc = createNote(db, c.id, { heading: 'third' });

    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(cc.position).toBe(2);

    const list = listNotesByConcept(db, c.id);
    expect(list.map(n => n.heading)).toEqual(['first', 'second', 'third']);
    db.close();
  });

  it('defaults blank heading to "Untitled note"', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);
    const n = createNote(db, c.id, { heading: '   ' });
    expect(n.heading).toBe('Untitled note');
    db.close();
  });

  it('updates heading and body, preserves the other on partial patch', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);
    const n = createNote(db, c.id, { heading: 'orig', body: 'body1' });

    const h = updateNote(db, n.id, { heading: 'renamed' });
    expect(h?.heading).toBe('renamed');
    expect(h?.body).toBe('body1');

    const bb = updateNote(db, n.id, { body: 'body2' });
    expect(bb?.heading).toBe('renamed');
    expect(bb?.body).toBe('body2');
    db.close();
  });

  it('deletes a note hard', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);
    const n = createNote(db, c.id, { heading: 'gone' });
    deleteNote(db, n.id);
    expect(listNotesByConcept(db, c.id)).toEqual([]);
    db.close();
  });

  it('reorders notes atomically by full id list', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);
    const a = createNote(db, c.id, { heading: 'a' });
    const b = createNote(db, c.id, { heading: 'b' });
    const cc = createNote(db, c.id, { heading: 'c' });

    const out = reorderNotes(db, c.id, [cc.id, a.id, b.id]);
    expect(out.map(n => n.heading)).toEqual(['c', 'a', 'b']);
    expect(out.map(n => n.position)).toEqual([0, 1, 2]);
    db.close();
  });

  it('rejects reorder containing a note from another concept', () => {
    const db = openDb(':memory:');
    const c1 = makeConcept(db, 'X');
    const c2 = makeConcept(db, 'Y');
    const a = createNote(db, c1.id, { heading: 'a' });
    const b = createNote(db, c2.id, { heading: 'b' });
    expect(() => reorderNotes(db, c1.id, [a.id, b.id])).toThrow();
    db.close();
  });

  it('cascades on concept delete', () => {
    const db = openDb(':memory:');
    const c = makeConcept(db);
    createNote(db, c.id, { heading: 'doomed' });
    db.prepare('DELETE FROM concepts WHERE id = ?').run(c.id);
    expect(listNotesByConcept(db, c.id)).toEqual([]);
    db.close();
  });
});
