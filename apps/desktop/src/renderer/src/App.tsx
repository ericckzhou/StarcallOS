import React, { useState, useEffect, useRef } from 'react';
import SourcePane, { type Source } from './components/SourcePane';
import ConceptPane, { type Concept } from './components/ConceptPane';
import DetailPane from './components/DetailPane';
import CandidateReview from './components/CandidateReview';
import ReviewQueue from './components/ReviewQueue';
import ProfilePane, { Avatar } from './components/ProfilePane';
import ParseRunsPanel from './components/ParseRunsPanel';
import ConstellationMap from './components/ConstellationMap';
import HubsPane from './components/HubsPane';
import { loadProfile, xpToNext, type Profile, type StudyProgress } from './components/profile';

type Tab = 'concepts' | 'candidates' | 'runs';

const SOURCE_TAB_KEY = 'starcall.layout.sourceTab';
// Last source the user opened in the Sources tab — the Map uses this to default
// to whatever you were most recently looking at, not just the largest source.
export const LAST_SOURCE_KEY = 'starcall.layout.lastSource';
const VALID_TABS: Tab[] = ['concepts', 'candidates', 'runs'];
function loadInitialTab(): Tab {
  const stored = localStorage.getItem(SOURCE_TAB_KEY);
  return (stored && (VALID_TABS as string[]).includes(stored)) ? (stored as Tab) : 'candidates';
}
type TopLevel = 'sources' | 'review' | 'map' | 'hubs' | 'profile';

export default function App() {
  const [topLevel, setTopLevel] = useState<TopLevel>('sources');
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [tab, setTab] = useState<Tab>(loadInitialTab);
  const [conceptsRefreshKey, setConceptsRefreshKey] = useState(0);
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [levelUp, setLevelUp] = useState<number | null>(null);
  const [xpPulse, setXpPulse] = useState(false);
  const prevLevel = useRef<number | null>(null);
  const prevXp = useRef<number | null>(null);

  // Celebrate level-ups and pulse the XP chip on XP gains. Guards the initial
  // load (prev refs start null) so we never fire on first render.
  useEffect(() => {
    if (!progress) return;
    if (prevLevel.current != null && progress.level > prevLevel.current) {
      setLevelUp(progress.level);
    }
    if (prevXp.current != null && progress.total_xp > prevXp.current) {
      setXpPulse(true);
      const t = setTimeout(() => setXpPulse(false), 700);
      prevLevel.current = progress.level;
      prevXp.current = progress.total_xp;
      return () => clearTimeout(t);
    }
    prevLevel.current = progress.level;
    prevXp.current = progress.total_xp;
  }, [progress]);

  useEffect(() => {
    window.api.sources.list().then(r => setSources(r as Source[]));
  }, []);

  useEffect(() => {
    const refreshProgress = () => {
      window.api.evidence.progress().then(p => setProgress(p as StudyProgress));
    };
    refreshProgress();
    window.addEventListener('starcall:progressChanged', refreshProgress);
    return () => window.removeEventListener('starcall:progressChanged', refreshProgress);
  }, []);

  // If the selected source disappears from the list (e.g. user deleted it),
  // clear selection so the panes don't keep rendering stale data.
  useEffect(() => {
    if (selectedSourceId != null && !sources.some(s => s.id === selectedSourceId)) {
      setSelectedSourceId(null);
      setSelectedConcept(null);
    }
  }, [sources, selectedSourceId]);

  function handleSourceSelect(id: number) {
    setSelectedSourceId(id);
    setSelectedConcept(null);
    localStorage.setItem(LAST_SOURCE_KEY, String(id));
  }

  function handleReviewSelect(c: Concept) {
    setSelectedConcept(c);
  }

  const tabBtn = (key: Tab, label: string): React.ReactNode => (
    <button
      key={key}
      onClick={() => setTab(key)}
      style={{
        background: tab === key ? 'rgba(129, 140, 248, 0.10)' : 'transparent',
        border: 'none',
        borderBottom: `2px solid ${tab === key ? '#818cf8' : 'transparent'}`,
        color: tab === key ? '#e2e8f0' : '#6b7280',
        padding: '8px 14px', fontSize: 12, fontWeight: 600,
        letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  const topBtn = (key: TopLevel, label: string): React.ReactNode => (
    <button
      key={key}
      onClick={() => { setTopLevel(key); setSelectedConcept(null); }}
      style={{
        background: 'transparent', border: 'none',
        color: topLevel === key ? '#e2e8f0' : '#6b7280',
        padding: '0 14px', height: 48, fontSize: 12, fontWeight: 600,
        letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
        borderBottom: `2px solid ${topLevel === key ? '#818cf8' : 'transparent'}`,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'transparent', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', position: 'relative', overflow: 'hidden' }}>
      {profile.backgroundDataUrl && (
        <>
          {profile.backgroundDataUrl.startsWith('data:video') ? (
            <video
              src={profile.backgroundDataUrl}
              autoPlay loop muted playsInline
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: Math.max(0, Math.min(1, profile.backgroundOpacity)),
                pointerEvents: 'none',
                zIndex: 0,
              }}
            />
          ) : (
            <img
              src={profile.backgroundDataUrl}
              alt=""
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: Math.max(0, Math.min(1, profile.backgroundOpacity)),
                pointerEvents: 'none',
                zIndex: 0,
              }}
            />
          )}
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(1, 2, 16, 0.72)',
            pointerEvents: 'none',
            zIndex: 0,
          }} />
        </>
      )}
      <header style={{ height: 48, padding: '0 20px', borderBottom: '1px solid rgba(35,42,85,0.65)', display: 'flex', alignItems: 'center', background: 'rgba(4,6,26,0.72)', backdropFilter: 'blur(18px)', flexShrink: 0, gap: 12, position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', height: '100%' }}>
          {topBtn('sources',  'Sources')}
          {topBtn('review',   'Review')}
          {topBtn('map',      'Map')}
          {topBtn('hubs',     'Hubs')}
        </div>
        <button
          onClick={() => { setTopLevel('profile'); setSelectedConcept(null); }}
          title="Open profile"
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10,
            background: topLevel === 'profile' ? '#1a1a2e' : 'transparent',
            border: `1px solid ${topLevel === 'profile' ? '#4338ca' : '#1f2937'}`,
            borderRadius: 8, padding: '5px 8px', cursor: 'pointer',
            color: '#e2e8f0',
          }}
        >
          <Avatar profile={profile} size={28} />
          {progress && (
            <div style={{ width: 185, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, lineHeight: 1.1 }}>
                <span style={{ fontSize: 11, color: '#e2e8f0', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {profile.name}
                </span>
                <span className={xpPulse ? 'xp-pulse' : undefined} style={{ fontSize: 10, color: '#94a3b8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  Lv {progress.level} · {progress.total_xp} XP
                </span>
              </div>
              <div style={{ marginTop: 4, height: 4, borderRadius: 2, background: 'rgba(31, 41, 55, 0.35)', overflow: 'hidden' }} title={`${xpToNext(progress)} XP to next milestone`}>
                <div style={{ height: '100%', width: `${Math.max(0, Math.min(1, progress.progress_ratio)) * 100}%`, background: '#818cf8' }} />
              </div>
            </div>
          )}
        </button>
      </header>

      {topLevel === 'profile' ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
          <ProfilePane profile={profile} progress={progress} onProfileChange={setProfile} />
        </div>
      ) : topLevel === 'map' ? (
        <ConstellationMap
          profile={profile}
          onConceptChanged={() => setConceptsRefreshKey(k => k + 1)}
        />
      ) : topLevel === 'hubs' ? (
        <HubsPane onChanged={() => setConceptsRefreshKey(k => k + 1)} />
      ) : topLevel === 'review' ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
          <ReviewQueue
            onSelect={handleReviewSelect}
            selectedConcept={selectedConcept}
            onDeleted={() => {
              setSelectedConcept(null);
              setConceptsRefreshKey(k => k + 1);
            }}
          />
          <DetailPane
            concept={selectedConcept}
            profile={profile}
            onDeleted={() => {
              setSelectedConcept(null);
              setConceptsRefreshKey(k => k + 1);
            }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
          <SourcePane
            sources={sources}
            selectedId={selectedSourceId}
            onSelect={handleSourceSelect}
            onSourcesChange={setSources}
          />
          {selectedSourceId ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{
                display: 'flex',
                borderBottom: '1px solid rgba(31,41,55,0.72)',
                background: 'rgba(4,6,26,0.34)',
                backdropFilter: 'blur(14px)',
                flexShrink: 0,
              }}>
                {tabBtn('candidates', 'Candidates')}
                {tabBtn('concepts',   'Concepts')}
                {tabBtn('runs',       'Runs')}
              </div>
              {tab === 'candidates' && (() => {
                const src = sources.find(s => s.id === selectedSourceId);
                return (
                  <CandidateReview
                    key={selectedSourceId}
                    sourceId={selectedSourceId}
                    sourceTitle={src?.title ?? src?.filename ?? ''}
                    onPromoted={() => setConceptsRefreshKey(k => k + 1)}
                  />
                );
              })()}
              {tab === 'concepts' && (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  <ConceptPane
                    key={`${selectedSourceId}:${conceptsRefreshKey}`}
                    sourceId={selectedSourceId}
                    selectedId={selectedConcept?.id ?? null}
                    onSelect={setSelectedConcept}
                  />
                  <DetailPane
            concept={selectedConcept}
            profile={profile}
            onDeleted={() => {
              setSelectedConcept(null);
              setConceptsRefreshKey(k => k + 1);
            }}
          />
                </div>
              )}
              {tab === 'runs' && (
                <ParseRunsPanel key={selectedSourceId} sourceId={selectedSourceId} />
              )}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', fontSize: 14 }}>
              Add a PDF source to get started.
            </div>
          )}
        </div>
      )}
      {levelUp != null && <LevelUpOverlay level={levelUp} onDone={() => setLevelUp(null)} />}
    </div>
  );
}

function LevelUpOverlay({ level, onDone }: { level: number; onDone: () => void }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    const t = setTimeout(onDone, reduced ? 1600 : 2600);
    return () => clearTimeout(t);
  }, [onDone, reduced]);
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDone}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, display: 'flex',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        animation: reduced ? 'lvlup-fade 1.6s ease forwards' : 'lvlup-fade 2.6s ease forwards',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        {!reduced && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div className="lvlup-rays" />
            <div className="lvlup-core" />
            <div className="lvlup-ring" />
            <div className="lvlup-ring lvlup-ring-2" />
            {Array.from({ length: 14 }).map((_, i) => (
              <span key={i} className="lvlup-spark" style={{ transform: `rotate(${i * (360 / 14)}deg)` }}>
                <span className="lvlup-spark-dot" />
              </span>
            ))}
          </div>
        )}
        <div className={reduced ? undefined : 'lvlup-badge'} style={{
          position: 'relative',
          padding: '14px 30px', borderRadius: 14,
          background: 'linear-gradient(135deg, #312e81, #6d28d9)',
          border: '1px solid #a78bfa', color: '#ede9fe',
          fontWeight: 900, fontSize: 30, letterSpacing: '0.04em',
          boxShadow: '0 0 38px rgba(167,139,250,0.65)', textAlign: 'center',
        }}>
          LEVEL {level}
        </div>
        <div className={reduced ? undefined : 'lvlup-sub'} style={{ position: 'relative', fontSize: 13, color: '#c7d2fe', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
          Level Up
        </div>
      </div>
    </div>
  );
}
