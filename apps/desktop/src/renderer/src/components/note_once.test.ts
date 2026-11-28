import { describe, expect, it } from 'vitest';
import { noteOnce } from './note_once';

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

  it('lets a failed save be retried', () => {
    const once = noteOnce();
    expect(once.claim(7)).toBe(true);
    once.release(7);
    expect(once.has(7)).toBe(false);
    expect(once.claim(7)).toBe(true);
  });
});
