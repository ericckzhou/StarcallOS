import React, { useRef, useState } from 'react';
import SettingsPane from './SettingsPane';
import { saveProfile, xpToNext, type Profile, type StudyProgress } from './profile';

interface Props {
  profile: Profile;
  progress: StudyProgress | null;
  onProfileChange: (profile: Profile) => void;
}

export default function ProfilePane({ profile, progress, onProfileChange }: Props) {
  const [name, setName] = useState(profile.name);
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(profile.avatarDataUrl);
  const [backgroundDataUrl, setBackgroundDataUrl] = useState<string | null>(profile.backgroundDataUrl);
  const [backgroundOpacity, setBackgroundOpacity] = useState(profile.backgroundOpacity);
  const [section, setSection] = useState<'profile' | 'settings'>('profile');
  const fileRef = useRef<HTMLInputElement>(null);
  const backgroundFileRef = useRef<HTMLInputElement>(null);

  function commit(next: Profile): void {
    saveProfile(next);
    onProfileChange(next);
  }

  function saveName(): void {
    const next = { ...profile, name: name.trim() || 'Student', avatarDataUrl, backgroundDataUrl, backgroundOpacity };
    setName(next.name);
    commit(next);
  }

  function uploadAvatar(file: File | null): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = { ...profile, name: name.trim() || 'Student', avatarDataUrl: String(reader.result), backgroundDataUrl, backgroundOpacity };
      setAvatarDataUrl(next.avatarDataUrl);
      commit(next);
    };
    reader.readAsDataURL(file);
  }

  function uploadBackground(file: File | null): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = { ...profile, name: name.trim() || 'Student', avatarDataUrl, backgroundDataUrl: String(reader.result), backgroundOpacity };
      setBackgroundDataUrl(next.backgroundDataUrl);
      commit(next);
    };
    reader.readAsDataURL(file);
  }

  function updateBackgroundOpacity(value: number): void {
    const nextOpacity = Math.max(0, Math.min(1, value));
    setBackgroundOpacity(nextOpacity);
    commit({ ...profile, name: name.trim() || 'Student', avatarDataUrl, backgroundDataUrl, backgroundOpacity: nextOpacity });
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <aside style={{ width: 220, borderRight: '1px solid #1f2937', background: '#0d0d16', padding: 16, boxSizing: 'border-box' }}>
        <Avatar profile={{ name, avatarDataUrl }} size={72} />
        <div style={{ marginTop: 10, fontSize: 16, fontWeight: 700 }}>{name}</div>
        {progress && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 5 }}>
              <span>{progress.total_xp} XP</span>
              <span>{progress.challenges_completed} challenges</span>
            </div>
            <ProgressBar progress={progress.progress_ratio} />
          </div>
        )}
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <NavButton active={section === 'profile'} onClick={() => setSection('profile')}>Profile</NavButton>
          <NavButton active={section === 'settings'} onClick={() => setSection('settings')}>Settings</NavButton>
        </div>
      </aside>

      {section === 'settings' ? (
        <SettingsPane />
      ) : (
        <main style={{ flex: 1, overflowY: 'auto', padding: 32 }}>
          <div style={{ maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <section style={{ ...panel, padding: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 18 }}>
                <Avatar profile={{ name, avatarDataUrl }} size={96} />
                <div style={{ minWidth: 0 }}>
                  <div style={eyebrow}>Profile</div>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onBlur={saveName}
                    onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
                    style={{
                      width: '100%', maxWidth: 420, background: '#111827',
                      border: '1px solid #263244', borderRadius: 6,
                      color: '#e2e8f0', padding: '8px 10px', fontSize: 16,
                      fontWeight: 700,
                      outline: 'none',
                    }}
                  />
                  {progress && (
                    <div style={{ marginTop: 10, maxWidth: 420 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: '#c7d2fe', fontWeight: 800 }}>{progress.total_xp} XP</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{xpToNext(progress)} XP to milestone</span>
                      </div>
                      <ProgressBar progress={progress.progress_ratio} />
                    </div>
                  )}
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    <button onClick={() => fileRef.current?.click()} style={buttonStyle}>Upload Icon</button>
                    {avatarDataUrl && (
                      <button
                        onClick={() => {
                          setAvatarDataUrl(null);
                          commit({ ...profile, name: name.trim() || 'Student', avatarDataUrl: null, backgroundDataUrl, backgroundOpacity });
                        }}
                        style={ghostButtonStyle}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    onChange={e => uploadAvatar(e.target.files?.[0] ?? null)}
                    style={{ display: 'none' }}
                  />
                </div>
                {progress && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 96px)', gap: 10 }}>
                    <MiniStat label="Challenges" value={String(progress.challenges_completed)} />
                    <MiniStat label="Difficulties" value={String(Object.values(progress.difficulty_counts).filter(Boolean).length)} />
                  </div>
                )}
              </div>
            </section>

            <section style={panel}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 18, alignItems: 'center' }}>
                <div>
                  <div style={eyebrow}>Concept Select Background</div>
                  <div style={{ marginTop: 8, color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>
                    Used only on the empty concept detail screen.
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => backgroundFileRef.current?.click()} style={buttonStyle}>Upload Background</button>
                    {backgroundDataUrl && (
                      <button
                        onClick={() => {
                          setBackgroundDataUrl(null);
                          commit({ ...profile, name: name.trim() || 'Student', avatarDataUrl, backgroundDataUrl: null, backgroundOpacity });
                        }}
                        style={ghostButtonStyle}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={backgroundFileRef}
                    type="file"
                    accept="image/*"
                    onChange={e => uploadBackground(e.target.files?.[0] ?? null)}
                    style={{ display: 'none' }}
                  />
                  <div style={{ marginTop: 16, maxWidth: 420 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Opacity</span>
                      <span style={{ fontSize: 11, color: '#c7d2fe', fontVariantNumeric: 'tabular-nums' }}>{Math.round(backgroundOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={backgroundOpacity}
                      onChange={e => updateBackgroundOpacity(Number(e.target.value))}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                <div style={{
                  height: 150,
                  border: '1px solid #1f2937',
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: '#050816',
                  position: 'relative',
                }}>
                  {backgroundDataUrl && (
                    <img
                      src={backgroundDataUrl}
                      alt=""
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: backgroundOpacity }}
                    />
                  )}
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(4,6,26,0.25), rgba(4,6,26,0.75))' }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 12 }}>
                    Select a concept to explore.
                  </div>
                </div>
              </div>
            </section>

            {progress && (
              <>
                <section style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={eyebrow}>Challenge Difficulty Completed</div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>{progress.challenges_completed} total</div>
                  </div>
                  <DifficultyChart counts={progress.difficulty_counts} />
                </section>
              </>
            )}

            <section style={panel}>
              <div style={eyebrow}>User Info</div>
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, fontSize: 12 }}>
                <InfoTile label="Name" value={profile.name} />
                <InfoTile label="Avatar" value={profile.avatarDataUrl ? 'Custom image' : 'Initials icon'} />
                <InfoTile label="Background" value={profile.backgroundDataUrl ? `${Math.round(profile.backgroundOpacity * 100)}% opacity` : 'Default'} />
                <InfoTile label="Storage" value="Local app profile" muted />
              </div>
              <div style={{ display: 'none' }}>
                <InfoLabel>Name</InfoLabel><span>{profile.name}</span>
                <InfoLabel>Avatar</InfoLabel><span>{profile.avatarDataUrl ? 'Custom image' : 'Initials icon'}</span>
                <InfoLabel>Storage</InfoLabel><span style={{ color: '#94a3b8' }}>Profile identity is stored locally in this app.</span>
              </div>
            </section>
          </div>
        </main>
      )}
    </div>
  );
}

export function Avatar({ profile, size }: { profile: Pick<Profile, 'name' | 'avatarDataUrl'>; size: number }) {
  const initials = profile.name.trim().slice(0, 2).toUpperCase() || 'ST';
  return profile.avatarDataUrl ? (
    <img
      src={profile.avatarDataUrl}
      alt=""
      style={{ width: size, height: size, borderRadius: 8, objectFit: 'cover', border: '1px solid #312e81', flexShrink: 0 }}
    />
  ) : (
    <div style={{
      width: size, height: size, borderRadius: 8, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#1e1b4b', border: '1px solid #312e81',
      color: '#c7d2fe', fontWeight: 800, fontSize: Math.max(11, size * 0.28),
    }}>
      {initials}
    </div>
  );
}

function DifficultyChart({ counts }: { counts: Record<1 | 2 | 3 | 4 | 5, number> }) {
  const max = Math.max(1, ...Object.values(counts));
  return (
    <div style={{ marginTop: 14, display: 'flex', alignItems: 'end', gap: 12, height: 150 }}>
      {([1, 2, 3, 4, 5] as const).map(d => (
        <div key={d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: '100%', maxWidth: 64,
            height: `${Math.max(6, (counts[d] / max) * 120)}px`,
            background: d >= 4 ? '#7c3aed' : d === 3 ? '#4f46e5' : '#2563eb',
            borderRadius: '4px 4px 2px 2px',
          }} />
          <div style={{ fontSize: 11, color: '#cbd5e1' }}>{counts[d]}</div>
          <div style={{ fontSize: 10, color: '#64748b' }}>D{d}</div>
        </div>
      ))}
    </div>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div style={{ height: 6, background: '#1f2937', borderRadius: 999, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%`, height: '100%', background: '#818cf8' }} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 8, padding: '12px 10px' }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 22, fontWeight: 800, color: '#e2e8f0' }}>{value}</div>
    </div>
  );
}

function InfoTile({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 6, padding: 12, minWidth: 0 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ marginTop: 7, color: muted ? '#94a3b8' : '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
    </div>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      textAlign: 'left', background: active ? '#1a1a2e' : 'transparent',
      border: `1px solid ${active ? '#4338ca' : '#1f2937'}`,
      borderRadius: 6, color: active ? '#c7d2fe' : '#94a3b8',
      padding: '8px 10px', cursor: 'pointer',
    }}>
      {children}
    </button>
  );
}

function InfoLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>{children}</span>;
}

const panel: React.CSSProperties = {
  background: '#0d0d16',
  border: '1px solid #1f2937',
  borderRadius: 8,
  padding: 18,
};

const eyebrow: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

const buttonStyle: React.CSSProperties = {
  background: '#312e81',
  border: '1px solid #4338ca',
  borderRadius: 5,
  padding: '6px 12px',
  color: '#c7d2fe',
  fontSize: 12,
  cursor: 'pointer',
};

const ghostButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #374151',
  borderRadius: 5,
  padding: '6px 12px',
  color: '#94a3b8',
  fontSize: 12,
  cursor: 'pointer',
};
