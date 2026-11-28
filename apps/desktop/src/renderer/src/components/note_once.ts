// One Ask answer is saved at most once per concept. `claim` is taken before the
// save starts, so a second click while the first save is still running is
// ignored too; `release` gives the claim back when a save fails, so it can be
// retried.
export interface NoteOnce {
  claim(conceptId: number): boolean;
  release(conceptId: number): void;
  has(conceptId: number): boolean;
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
