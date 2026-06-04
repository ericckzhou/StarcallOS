import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { loadProfile, saveProfile, xpToNext, DEFAULT_PROFILE, type StudyProgress } from './profile';

// profile.ts reads/writes localStorage, which the node test environment does
// not provide. Stub a minimal in-memory implementation per test.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadProfile', () => {
  it('returns the default profile when nothing is stored', () => {
    expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('round-trips a saved profile', () => {
    const profile = { name: 'Ada', avatarDataUrl: 'data:img', backgroundDataUrl: null, backgroundOpacity: 0.5 };
    saveProfile(profile);
    expect(loadProfile()).toEqual(profile);
  });

  it('falls back to the default profile on corrupt JSON', () => {
    localStorage.setItem('starcall.profile', '{not valid json');
    expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('trims the name and defaults a blank name to "Student"', () => {
    saveProfile({ ...DEFAULT_PROFILE, name: '  Ada  ' });
    expect(loadProfile().name).toBe('Ada');

    saveProfile({ ...DEFAULT_PROFILE, name: '   ' });
    expect(loadProfile().name).toBe('Student');
  });

  it('clamps background opacity into [0, 1] and defaults non-finite values', () => {
    saveProfile({ ...DEFAULT_PROFILE, backgroundOpacity: 5 });
    expect(loadProfile().backgroundOpacity).toBe(1);

    saveProfile({ ...DEFAULT_PROFILE, backgroundOpacity: -3 });
    expect(loadProfile().backgroundOpacity).toBe(0);

    // A non-numeric opacity → NaN → falls back to the default.
    localStorage.setItem('starcall.profile', JSON.stringify({ backgroundOpacity: 'nope' }));
    expect(loadProfile().backgroundOpacity).toBe(DEFAULT_PROFILE.backgroundOpacity);
  });

  it('coerces non-string avatar/background values to null', () => {
    localStorage.setItem('starcall.profile', JSON.stringify({ avatarDataUrl: 123, backgroundDataUrl: '' }));
    const profile = loadProfile();
    expect(profile.avatarDataUrl).toBeNull();
    expect(profile.backgroundDataUrl).toBeNull();
  });
});

describe('xpToNext', () => {
  it('returns the gap between total XP and the next level threshold', () => {
    expect(xpToNext({ total_xp: 30, next_level_xp: 100 } as StudyProgress)).toBe(70);
  });

  it('never returns a negative number', () => {
    expect(xpToNext({ total_xp: 250, next_level_xp: 100 } as StudyProgress)).toBe(0);
  });
});
