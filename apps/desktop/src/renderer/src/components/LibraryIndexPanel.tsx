import React, { useCallback, useEffect, useState } from 'react';
import type { LibraryIndexProgress, LibraryIndexSummary, RagLibraryStatus } from '@starcall/shared';

// Whole-library passage index controls (Ask rail + Settings). The job runs in
// the main process; this panel only starts/stops it and mirrors its progress,
// so leaving the screen never interrupts it. Fires `starcall:ragIndexChanged`
// when a run ends so other views refresh their per-source counts.

export const RAG_INDEX_CHANGED = 'starcall:ragIndexChanged';

function summaryText(s: LibraryIndexSummary): string {
  const parts = [
    s.chunked ? `${s.chunked} indexed` : null,
    s.rechunked ? `${s.rechunked} re-indexed` : null,
    s.embedded_chunks ? `${s.embedded_chunks.toLocaleString()} passages embedded` : null,
  ].filter(Boolean);
  const head = s.stopped ? 'Stopped' : 'Done';
  return parts.length ? `${head}: ${parts.join(', ')}.` : `${head}: nothing new.`;
}

export default function LibraryIndexPanel({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<RagLibraryStatus | null>(null);
  const [progress, setProgress] = useState<LibraryIndexProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const refresh = useCallback(() => {
    window.api.rag.libraryStatus().then(s => { setStatus(s); setProgress(s.progress); }).catch(() => setStatus(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => window.api.rag.onLibraryProgress(p => {
    setProgress(p);
    setStatus(s => (s && !s.running ? { ...s, running: true } : s));
  }), []);
  useEffect(() => window.api.rag.onLibraryDone(() => {
    setStopping(false);
    setProgress(null);
    refresh();
    window.dispatchEvent(new Event(RAG_INDEX_CHANGED));
  }), [refresh]);
  // Other views (per-source Index, Ask's lazy embedding) change coverage too.
  useEffect(() => {
    window.addEventListener(RAG_INDEX_CHANGED, refresh);
    return () => window.removeEventListener(RAG_INDEX_CHANGED, refresh);
  }, [refresh]);

  async function start() {
    setError(null);
    const r = await window.api.rag.libraryStart();
    if (!r.ok) setError(r.error);
    refresh();
  }
  async function stop() {
    setStopping(true);
    await window.api.rag.libraryStop();
  }

  if (!status) return null;
  const { plan, running, last } = status;
  const indexed = plan.sources - plan.unindexed;
  const embedTotal = plan.embedding_model ? plan.chunks : 0;
  const coverage = [
    `${indexed}/${plan.sources} sources indexed`,
    plan.stale ? `${plan.stale} outdated` : null,
    plan.embedding_model ? `${plan.embedded.toLocaleString()}/${embedTotal.toLocaleString()} embedded` : null,
  ].filter(Boolean).join(' · ');
  const resumable = !running && !plan.done && last?.stopped;
  const label = running ? null : plan.done ? 'Up to date' : resumable ? 'Resume indexing' : 'Index library';
  const failures = last?.failures ?? [];

  return (
    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      <div title={plan.embedding_model ? `Embedding model: ${plan.embedding_model}` : 'Embeddings are off: passages get keyword search only'}>
        {coverage}
      </div>
      {running ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {progress
                ? `${progress.phase === 'chunk' ? 'Reading' : 'Embedding'} “${progress.title}” (${progress.sourceIndex}/${progress.sourceCount})`
                : 'Starting…'}
            </span>
            <button onClick={() => void stop()} disabled={stopping} style={btn} title="Stop after the current batch; finished work is kept and can be resumed">
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(31,41,55,0.5)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', background: 'var(--indigo-400)',
              width: `${progress ? ((progress.sourceIndex - 1 + (progress.total ? progress.done / progress.total : 0)) / progress.sourceCount) * 100 : 0}%`,
            }} />
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={() => void start()} disabled={plan.done} style={{ ...btn, opacity: plan.done ? 0.55 : 1 }}
            title={plan.done ? 'Every source is indexed' : 'Index every source in the background. You can keep working, stop at any time, and resume later.'}>
            {label}
          </button>
          {!compact && !plan.done && (
            <span style={{ color: 'var(--text-muted)' }}>Runs in the background; stop any time and resume later.</span>
          )}
        </div>
      )}
      {!running && last && (
        <div style={{ marginTop: 6, color: failures.length || last.embed_error ? '#fbbf24' : '#86efac' }}>
          {summaryText(last)}
          {last.embed_error && <div style={{ color: 'var(--amber-400)' }}>Embedding stopped: {last.embed_error}</div>}
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
      {plan.stale > 0 && !running && !compact && (
        <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
          Outdated sources get re-indexed passages only; re-extract their candidates under Outdated sources below.
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
