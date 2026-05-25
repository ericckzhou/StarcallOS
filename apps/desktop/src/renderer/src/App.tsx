import React, { useState, useEffect } from 'react';
import SourcePane, { type Source } from './components/SourcePane';
import ConceptPane, { type Concept } from './components/ConceptPane';
import DetailPane from './components/DetailPane';
import CandidateReview from './components/CandidateReview';
import ReviewQueue from './components/ReviewQueue';
import SettingsPane from './components/SettingsPane';
import ParseRunsPanel from './components/ParseRunsPanel';

type Tab = 'concepts' | 'candidates' | 'runs';
type TopLevel = 'sources' | 'review' | 'settings';

export default function App() {
  const [topLevel, setTopLevel] = useState<TopLevel>('sources');
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [tab, setTab] = useState<Tab>('concepts');
  const [conceptsRefreshKey, setConceptsRefreshKey] = useState(0);

  useEffect(() => {
    window.api.sources.list().then(r => setSources(r as Source[]));
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
        background: tab === key ? '#1a1a2e' : 'transparent',
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0f', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ height: 48, padding: '0 20px', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', background: '#0d0d16', flexShrink: 0, gap: 12 }}>
        <div style={{ display: 'flex', height: '100%' }}>
          {topBtn('sources',  'Sources')}
          {topBtn('review',   'Review')}
          {topBtn('settings', 'Settings')}
        </div>
      </header>

      {topLevel === 'settings' ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <SettingsPane />
        </div>
      ) : topLevel === 'review' ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <ReviewQueue onSelect={handleReviewSelect} selectedConcept={selectedConcept} />
          <DetailPane
            concept={selectedConcept}
            onDeleted={() => {
              setSelectedConcept(null);
              setConceptsRefreshKey(k => k + 1);
            }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <SourcePane
            sources={sources}
            selectedId={selectedSourceId}
            onSelect={handleSourceSelect}
            onSourcesChange={setSources}
          />
          {selectedSourceId ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid #1f2937', background: '#0d0d16', flexShrink: 0 }}>
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
