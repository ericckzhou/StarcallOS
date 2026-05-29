export interface Profile {
  name: string;
  avatarDataUrl: string | null;
  backgroundDataUrl: string | null;
  backgroundOpacity: number;
}

export interface SourceChallengeCount {
  source_id: number;
  source_title: string;
  count: number;
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD
  count: number;
  sources: { source_title: string; count: number }[];
}

export interface StudyProgress {
  total_xp: number;
  level: number;
  current_level_xp: number;
  next_level_xp: number;
  progress_ratio: number;
  challenges_completed: number;
  difficulty_counts: Record<1 | 2 | 3 | 4 | 5, number>;
  source_counts: SourceChallengeCount[];
  daily_activity: DailyActivity[];
}

const PROFILE_KEY = 'starcall.profile';

export const DEFAULT_PROFILE: Profile = {
  name: 'Student',
  avatarDataUrl: null,
  backgroundDataUrl: null,
  backgroundOpacity: 0.22,
};

function clampOpacity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PROFILE.backgroundOpacity;
  return Math.max(0, Math.min(1, n));
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : DEFAULT_PROFILE.name,
      avatarDataUrl: typeof parsed.avatarDataUrl === 'string' && parsed.avatarDataUrl ? parsed.avatarDataUrl : null,
      backgroundDataUrl: typeof parsed.backgroundDataUrl === 'string' && parsed.backgroundDataUrl ? parsed.backgroundDataUrl : null,
      backgroundOpacity: clampOpacity(parsed.backgroundOpacity),
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function xpToNext(progress: StudyProgress): number {
  return Math.max(0, progress.next_level_xp - progress.total_xp);
}
