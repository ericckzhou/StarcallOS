import React, { useRef, useState } from 'react';
import SettingsPane from './SettingsPane';
import { saveProfile, xpToNext, type Profile, type StudyProgress, type DailyActivity } from './profile';

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
      <aside style={{ width: 220, borderRight: '1px solid #1f2937', background: 'rgba(13, 13, 22, 0.35)', padding: 16, boxSizing: 'border-box' }}>
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
                  <div style={eyebrow}>Select Background</div>
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
                    accept="image/*,video/mp4,video/webm"
                    onChange={e => uploadBackground(e.target.files?.[0] ?? null)}
                    style={{ display: 'none' }}
                  />
                  <div style={{ marginTop: 16, maxWidth: 420 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Opacity</span>
                      <span style={{ fontSize: 11, color: '#c7d2fe', fontVariantNumeric: 'tabular-nums' }}>{Math.round(backgroundOpacity * 100)}%</span>
                    </div>
                    <input
                      className="glass-range"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={backgroundOpacity}
                      onChange={e => updateBackgroundOpacity(Number(e.target.value))}
                      style={{ width: '100%', ['--fill' as string]: `${backgroundOpacity * 100}%` } as React.CSSProperties}
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
                    backgroundDataUrl.startsWith('data:video') ? (
                      <video
                        src={backgroundDataUrl}
                        autoPlay loop muted playsInline
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: backgroundOpacity }}
                      />
                    ) : (
                      <img
                        src={backgroundDataUrl}
                        alt=""
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: backgroundOpacity }}
                      />
                    )
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
                    <div style={eyebrow}>Challenge Activity</div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>{progress.challenges_completed} in the last year</div>
                  </div>
                  <ActivityHeatmap activity={progress.daily_activity} />
                </section>
                <section style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={eyebrow}>Challenges by Source</div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>{progress.source_counts.length} source{progress.source_counts.length === 1 ? '' : 's'}</div>
                  </div>
                  <SourceChallengeChart counts={progress.source_counts} />
                </section>
              </>
            )}
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

// GitHub-style contribution heatmap of challenges completed, themed to the app's
// indigo palette. 53 weeks ending today; intensity buckets by daily count.
const HEAT_LEVELS = ['rgba(40, 46, 70, 0.5)', '#3b3573', '#5b50c4', '#818cf8', '#c4b5fd'];
const HEAT_CELL = 11;
const HEAT_GAP = 3;
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function heatLevel(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

// "2026-05-29" -> "May 29 2026"
function formatHeatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTH_NAMES[m - 1]} ${d} ${y}`;
}

function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type HeatCell = { date: string; count: number; future: boolean; month: number; sources: { source_title: string; count: number }[] };

function ActivityHeatmap({ activity }: { activity: DailyActivity[] }) {
  const [tip, setTip] = useState<{ x: number; y: number; cell: HeatCell } | null>(null);
  const byDate = new Map(activity.map(a => [a.date, a]));
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  // Walk back to the Sunday that starts the 53-week window.
  const start = new Date(end);
  start.setDate(start.getDate() - (52 * 7 + end.getDay()));

  const weeks: HeatCell[][] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const week: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = toLocalISO(cur);
      const rec = byDate.get(iso);
      week.push({ date: iso, count: rec?.count ?? 0, future: cur > end, month: cur.getMonth(), sources: rec?.sources ?? [] });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels: label the first week of each month, but skip the leading
  // partial month and enforce a min column gap so adjacent labels (each wider
  // than one cell) never overlap — e.g. "May"/"Jun" colliding at the start.
  const MIN_LABEL_GAP = 3;
  const monthLabels: string[] = [];
  let lastLabeled = -MIN_LABEL_GAP;
  for (let i = 0; i < weeks.length; i++) {
    const m = weeks[i][0].month;
    const prev = i > 0 ? weeks[i - 1][0].month : m;
    if (i > 0 && m !== prev && i - lastLabeled >= MIN_LABEL_GAP) {
      monthLabels.push(MONTH_NAMES[m]);
      lastLabeled = i;
    } else {
      monthLabels.push('');
    }
  }

  return (
    <div style={{ marginTop: 14, overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {/* Weekday labels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: HEAT_GAP, paddingTop: 16, flexShrink: 0 }}>
          {WEEKDAY_LABELS.map((lbl, i) => (
            <div key={i} style={{ height: HEAT_CELL, fontSize: 9, color: '#64748b', lineHeight: `${HEAT_CELL}px`, width: 24, textAlign: 'right' }}>{lbl}</div>
          ))}
        </div>
        {/* Month labels + grid */}
        <div>
          <div style={{ display: 'flex', gap: HEAT_GAP, height: 16 }}>
            {monthLabels.map((lbl, i) => (
              <div key={i} style={{ width: HEAT_CELL, fontSize: 9, color: '#64748b', whiteSpace: 'nowrap', overflow: 'visible' }}>{lbl}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: HEAT_GAP }}>
            {weeks.map((week, wi) => (
              <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: HEAT_GAP }}>
                {week.map((cell, di) => (
                  <div
                    key={di}
                    onMouseEnter={e => { if (!cell.future) setTip({ x: e.clientX, y: e.clientY, cell }); }}
                    onMouseMove={e => { if (!cell.future) setTip({ x: e.clientX, y: e.clientY, cell }); }}
                    onMouseLeave={() => setTip(null)}
                    style={{
                      width: HEAT_CELL, height: HEAT_CELL, borderRadius: 2,
                      background: cell.future ? 'transparent' : HEAT_LEVELS[heatLevel(cell.count)],
                      outline: cell.count > 0 ? '1px solid rgba(196,181,253,0.15)' : 'none',
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Legend */}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, fontSize: 10, color: '#64748b' }}>
        <span>Less</span>
        {HEAT_LEVELS.map((c, i) => (
          <span key={i} style={{ width: HEAT_CELL, height: HEAT_CELL, borderRadius: 2, background: c, display: 'inline-block' }} />
        ))}
        <span>More</span>
      </div>
      {/* Themed tooltip: count + per-source breakdown for the hovered day. */}
      {tip && (
        <div style={{
          position: 'fixed', left: tip.x + 12, top: tip.y + 14, zIndex: 9999, pointerEvents: 'none',
          background: 'rgba(13, 13, 22, 0.96)', border: '1px solid #312e81', borderRadius: 6,
          padding: '7px 9px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxWidth: 240,
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#e2e8f0' }}>
            {tip.cell.count} challenge{tip.cell.count === 1 ? '' : 's'}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{formatHeatDate(tip.cell.date)}</div>
          {tip.cell.sources.length > 0 && (
            <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {tip.cell.sources.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#cbd5e1' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: SOURCE_PALETTE[i % SOURCE_PALETTE.length], flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.source_title}</span>
                  <span style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{s.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SOURCE_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee',
  '#fb7185', '#a3e635', '#f59e0b', '#818cf8', '#2dd4bf', '#e879f9',
];

function SourceChallengeChart({ counts }: { counts: { source_id: number; source_title: string; count: number }[] }) {
  if (counts.length === 0) {
    return <div style={{ marginTop: 14, fontSize: 12, color: '#475569' }}>No challenges completed yet.</div>;
  }
  const max = Math.max(1, ...counts.map(c => c.count));
  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {counts.map((c, i) => {
        const color = SOURCE_PALETTE[i % SOURCE_PALETTE.length];
        return (
          <div key={c.source_id} className="csbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div title={c.source_title} style={{ width: 150, flexShrink: 0, fontSize: 12, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              {c.source_title}
            </div>
            <div style={{ flex: 1, minWidth: 0, height: 14, background: 'rgba(31,41,55,0.55)', borderRadius: 4, overflow: 'hidden' }}>
              <div className="csbar-fill" style={{ width: `${(c.count / max) * 100}%`, height: '100%', background: color, borderRadius: 4, animationDelay: `${i * 90}ms` }} />
            </div>
            <div style={{ width: 28, flexShrink: 0, textAlign: 'right', fontSize: 12, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{c.count}</div>
          </div>
        );
      })}
    </div>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div style={{ height: 6, background: 'rgba(31, 41, 55, 0.35)', borderRadius: 999, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%`, height: '100%', background: '#818cf8' }} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'rgba(11, 18, 32, 0.4)', border: '1px solid #1f2937', borderRadius: 8, padding: '12px 10px' }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 22, fontWeight: 800, color: '#e2e8f0' }}>{value}</div>
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

const panel: React.CSSProperties = {
  background: 'rgba(13, 13, 22, 0.35)',
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
