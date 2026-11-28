import { describe, expect, it } from 'vitest';
import { hasSameNote, noteOnce } from './note_once';

describe('saving an Ask answer as a note', () => {
  it('saves once per concept, even when clicked again before the first save finishes', () => {
    const once = noteOnce();
    expect(once.claim(7)).toBe(true);
    expect(once.claim(7)).toBe(false);
    expect(once.claim(7)).toBe(false);
    expect(once.has(7)).toBe(true);
  });

  it('still allows the same answer on a different concept', () => {
    const once = noteOnce();
    expect(once.claim(7)).toBe(true);
    expect(once.claim(8)).toBe(true);
  });

  it('finds the same answer already saved, ignoring surrounding whitespace', () => {
    const notes = [{ heading: 'Q: Define Caching.', body: 'Caching stores data.\n\nSources:\n[1] p.58' }];
    expect(hasSameNote(notes, 'Q: Define Caching.', '  Caching stores data.\n\nSources:\n[1] p.58\n')).toBe(true);
  });

  it('saves a different answer to the same question, and the same answer under another question', () => {
    const notes = [{ heading: 'Q: Define Caching.', body: 'Caching stores data.' }];
    expect(hasSameNote(notes, 'Q: Define Caching.', 'Caching keeps copies close to the reader.')).toBe(false);
    expect(hasSameNote(notes, 'Q: what is caching', 'Caching stores data.')).toBe(false);
    expect(hasSameNote([], 'Q: Define Caching.', 'Caching stores data.')).toBe(false);
  });

  it('lets a failed save be retried', () => {
    const once = noteOnce();
    expect(once.claim(7)).toBe(true);
    once.release(7);
    expect(once.has(7)).toBe(false);
    expect(once.claim(7)).toBe(true);
  });
});
