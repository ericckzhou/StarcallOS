import React, { useState, useEffect } from 'react';
import SourcePane, { type Source } from './components/SourcePane';
import ConceptPane, { type Concept } from './components/ConceptPane';
import DetailPane from './components/DetailPane';
import CandidateReview from './components/CandidateReview';
import ReviewQueue from './components/ReviewQueue';
import ProfilePane, { Avatar } from './components/ProfilePane';
import ParseRunsPanel from './components/ParseRunsPanel';
import { loadProfile, xpToNext, type Profile, type StudyProgress } from './components/profile';

type Tab = 'concepts' | 'candidates' | 'runs';

const SOURCE_TAB_KEY = 'starcall.layout.sourceTab';
const VALID_TABS: Tab[] = ['concepts', 'candidates', 'runs'];
function loadInitialTab(): Tab {
  const stored = localStorage.getItem(SOURCE_TAB_KEY);
  return (stored && (VALID_TABS as string[]).includes(stored)) ? (stored as Tab) : 'candidates';
}
type TopLevel = 'sources' | 'review' | 'profile';

export default function App() {
  const [topLevel, setTopLevel] = useState<TopLevel>('sources');
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [tab, setTab] = useState<Tab>(loadInitialTab);
  const [conceptsRefreshKey, setConceptsRefreshKey] = useState(0);
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [progress, setProgress] = useState<StudyProgress | null>(null);

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
                <span style={{ fontSize: 10, color: '#94a3b8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  Lv {progress.level} · {progress.total_xp} XP
                </span>
              </div>
              <div style={{ marginTop: 4, height: 4, borderRadius: 2, background: '#1f2937', overflow: 'hidden' }} title={`${xpToNext(progress)} XP to next milestone`}>
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
    </div>
  );
}
