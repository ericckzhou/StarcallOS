import React, { useCallback, useEffect, useState } from 'react';
import type { ReextractProgress, ReextractStatus, ReextractSummary } from '@starcall/shared';
import { RAG_INDEX_CHANGED } from './LibraryIndexPanel';

// Settings → "Outdated sources": bulk re-extract of sources whose candidates
// came from an older parser/grammar/layout. The job runs in the main process;
// this panel starts/stops it and mirrors progress, so leaving Settings never
// interrupts it. Re-extract keeps promoted concepts and study history.

const REASON_LABEL: Record<string, string> = {
  parser: 'parser', grammar: 'grammar', layout: 'layout', unknown: 'version unknown',
};

function summaryText(s: ReextractSummary): string {
  const head = s.stopped ? 'Stopped' : 'Done';
  return s.reextracted ? `${head}: ${s.reextracted} source${s.reextracted === 1 ? '' : 's'} re-extracted.` : `${head}: nothing re-extracted.`;
}

export default function ReextractPanel() {
  const [status, setStatus] = useState<ReextractStatus | null>(null);
  const [progress, setProgress] = useState<ReextractProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const refresh = useCallback(() => {
    window.api.reextract.status().then(s => { setStatus(s); setProgress(s.progress); }).catch(() => setStatus(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => window.api.reextract.onProgress(p => {
    setProgress(p);
    setStatus(s => (s && !s.running ? { ...s, running: true } : s));
  }), []);
  useEffect(() => window.api.reextract.onDone(() => {
    setStopping(false);
    setProgress(null);
    refresh();
    // Re-extract also re-syncs passages and can change review-queue rows.
    window.dispatchEvent(new Event(RAG_INDEX_CHANGED));
    window.dispatchEvent(new Event('starcall:review-queue-stale'));
  }), [refresh]);

  async function start() {
    setError(null);
    const r = await window.api.reextract.start();
    if (!r.ok) setError(r.error);
    refresh();
  }
  async function stop() {
    setStopping(true);
    await window.api.reextract.stop();
  }

  if (!status) return null;
  const { plan, running, last } = status;
  const failures = last?.failures ?? [];
  const current = `parser ${plan.current.parser} · grammar ${plan.current.grammar} · layout ${plan.current.layout}`;

  return (
    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      <div title={`Current versions: ${current}`}>
        {plan.outdated
          ? `${plan.outdated} of ${plan.processed_sources} processed sources are outdated`
          : `All ${plan.processed_sources} processed sources are up to date`}
      </div>
      {!running && plan.items.length > 0 && (
        <details style={{ marginTop: 2 }}>
          <summary style={{ cursor: 'pointer' }}>Show sources</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {plan.items.map(i => (
              <li key={i.source_id}>{i.title} <span style={{ color: 'var(--text-muted)' }}>({i.reasons.map(r => REASON_LABEL[r] ?? r).join(', ')})</span></li>
            ))}
          </ul>
        </details>
      )}
      {running ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {progress ? `Re-extracting “${progress.title}” (${progress.sourceIndex}/${progress.sourceCount})` : 'Starting…'}
            </span>
            <button onClick={() => void stop()} disabled={stopping} style={btn} title="Stop after the current source; finished sources are kept and the rest can be resumed">
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(31,41,55,0.5)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', background: 'var(--indigo-400)',
              width: `${progress ? ((progress.sourceIndex - 1) / progress.sourceCount) * 100 : 0}%`,
            }} />
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={() => void start()} disabled={plan.done} style={{ ...btn, opacity: plan.done ? 0.55 : 1 }}
            title={plan.done ? 'Every processed source was extracted with the current parser' : 'Re-extract the outdated sources in the background, one at a time. You can keep working and stop at any time.'}>
            {plan.done ? 'Up to date' : last?.stopped ? 'Resume re-extract' : 'Re-extract outdated'}
          </button>
          {!plan.done && <span style={{ color: 'var(--text-muted)' }}>Promoted concepts, notes and study history are kept.</span>}
        </div>
      )}
      {!running && last && (
        <div style={{ marginTop: 6, color: failures.length ? '#fbbf24' : '#86efac' }}>
          {summaryText(last)}
          {failures.length > 0 && (
            <details style={{ marginTop: 2 }}>
              <summary style={{ cursor: 'pointer' }}>{failures.length} skipped</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {failures.map((f, i) => <li key={i}>{f.title}: {f.error}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && <div style={{ marginTop: 6, color: 'var(--text-danger)' }}>{error}</div>}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.4)', color: 'var(--text-accent)',
  borderRadius: 6, padding: '2px 9px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
};
