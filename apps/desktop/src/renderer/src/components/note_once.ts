// One Ask answer is saved at most once per concept. `claim` is taken before the
// save starts, so a second click while the first save is still running is
// ignored too; `release` gives the claim back when a save fails, so it can be
// retried.
export interface NoteOnce {
  claim(conceptId: number): boolean;
  release(conceptId: number): void;
  has(conceptId: number): boolean;
}

// True when a concept already has this note: the same heading and body,
// ignoring surrounding whitespace. Catches a repeat save of the same answer
// after the page was reopened or the app restarted. A different answer to the
// same question has a different body, so it still saves.
export function hasSameNote(notes: ReadonlyArray<{ heading: string; body: string }>, heading: string, body: string): boolean {
  const h = heading.trim();
  const b = body.trim();
  return notes.some(n => n.heading.trim() === h && n.body.trim() === b);
}

export function noteOnce(): NoteOnce {
  const claimed = new Set<number>();
  return {
    claim(conceptId) {
      if (claimed.has(conceptId)) return false;
      claimed.add(conceptId);
      return true;
    },
    release(conceptId) {
      claimed.delete(conceptId);
    },
    has(conceptId) {
      return claimed.has(conceptId);
    },
  };
}
