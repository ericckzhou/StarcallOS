import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type Source = {
  id: number;
  filename: string;
  title: string | null;
  author: string | null;
  status: string;
  page_count: number | null;
  error_msg: string | null;
};

interface Props {
  sources: Source[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onSourcesChange: (sources: Source[]) => void;
}

const STATUS: Record<string, { color: string; label: string }> = {
  pending:    { color: '#6b7280', label: 'Pending' },
  processing: { color: '#f59e0b', label: 'Processing…' },
  ready:      { color: '#22c55e', label: 'Ready' },
  failed:     { color: '#ef4444', label: 'Failed' },
};
const COLLAPSED_KEY = 'starcall.layout.sourcesCollapsed';

export default function SourcePane({ sources, selectedId, onSelect, onSourcesChange }: Props) {
  const [extracting, setExtracting] = useState<number | null>(null);
  const [textModal, setTextModal] = useState(false);
  const [textContent, setTextContent] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [processSummaries, setProcessSummaries] = useState<Record<number, string>>({});
  // Deleting a source cascades away concepts/evidence/XP, so we defer the real
  // delete behind a 5s undo window instead of a confirm popup. Nothing is
  // destroyed until the timer fires — undo just cancels it and restores the row.
  const [pendingDeletes, setPendingDeletes] = useState<{ source: Source; index: number }[]>([]);
  const deleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => () => { for (const t of deleteTimers.current.values()) clearTimeout(t); }, []);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    if (!textModal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeTextModal();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [textModal]);

  const textCharCount = textContent.length;
  const textWordCount = textContent.trim() ? textContent.trim().split(/\s+/).length : 0;

  function closeTextModal() {
    setTextModal(false);
    setTextContent('');
    setTextTitle('');
  }

  function handleTextBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (textContent.trim() || textTitle.trim()) return;
    closeTextModal();
  }

  if (collapsed) {
    return (
      <aside style={{
        width: 36, borderRight: '1px solid rgba(31,41,55,0.75)', background: 'rgba(13,13,22,0.42)', backdropFilter: 'blur(10px)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8,
      }}>
        <button
          onClick={() => setCollapsed(false)}
          title={`Sources (${sources.length}) - click to expand`}
          style={{
            background: 'transparent', border: '1px solid #1f2937', borderRadius: 3,
            color: '#9ca3af', fontSize: 12, padding: '4px 6px', cursor: 'pointer',
            writingMode: 'vertical-rl', textOrientation: 'mixed',
          }}
        >
          Sources ({sources.length})
        </button>
      </aside>
    );
  }

  async function handleAdd() {
    const result = await window.api.sources.create({});
    if (!result) return;
    const added = Array.isArray(result) ? result as Source[] : [result as Source];
    if (added.length > 0) onSourcesChange([...sources, ...added]);
  }

  async function handleAddText() {
    if (!textContent.trim()) return;
    const source = await (window.api.sources as any).createText({ text: textContent.trim(), title: textTitle.trim() || undefined });
    if (source) onSourcesChange([...sources, source as Source]);
    closeTextModal();
  }

  function handleDelete(e: React.MouseEvent, sourceId: number) {
    e.stopPropagation();
    if (deleteTimers.current.has(sourceId)) return;
    const index = sources.findIndex(s => s.id === sourceId);
    const source = sources[index];
    if (!source) return;
    // Optimistically remove from the list; the DB row survives until the timer.
    onSourcesChange(sources.filter(s => s.id !== sourceId));
    setPendingDeletes(prev => [...prev, { source, index }]);
    const timer = setTimeout(() => {
      deleteTimers.current.delete(sourceId);
      setPendingDeletes(prev => prev.filter(p => p.source.id !== sourceId));
      void window.api.sources.delete(sourceId).then(() => {
        // The cascade changes XP, challenge counts, and the review queue —
        // tell the rest of the app to refetch.
        window.dispatchEvent(new Event('starcall:progressChanged'));
        window.dispatchEvent(new Event('starcall:review-queue-stale'));
      });
    }, 5000);
    deleteTimers.current.set(sourceId, timer);
  }

  function undoDelete(entry: { source: Source; index: number }) {
    const timer = deleteTimers.current.get(entry.source.id);
    if (timer) { clearTimeout(timer); deleteTimers.current.delete(entry.source.id); }
    setPendingDeletes(prev => prev.filter(p => p.source.id !== entry.source.id));
    const next = [...sources];
    next.splice(Math.min(entry.index, next.length), 0, entry.source);
    onSourcesChange(next);
  }

  async function handleExtract(e: React.MouseEvent, sourceId: number) {
    e.stopPropagation();
    setExtracting(sourceId);
    onSourcesChange(sources.map(s => s.id === sourceId ? { ...s, status: 'processing', error_msg: null } : s));
    const result = await window.api.sources.process({ sourceId });
    if (result.ok) {
      const parts = [
        result.mode ?? 'processed',
        result.blocks != null ? `${result.blocks} blocks` : null,
        result.candidates != null ? `${result.candidates} candidates` : null,
        result.equations != null ? `${result.equations} equations` : null,
        result.llmCalls != null ? `${result.llmCalls} LLM calls` : null,
      ].filter(Boolean);
      setProcessSummaries(prev => ({
        ...prev,
        [sourceId]: result.warning ? `${parts.join(' · ')} · ${result.warning}` : parts.join(' · '),
      }));
    }
    // On success, error_msg is cleared in the DB by updateSourceStatus — mirror that locally.
    onSourcesChange(sources.map(s => s.id === sourceId
      ? { ...s, status: result.ok ? 'ready' : 'failed', error_msg: result.ok ? null : (result.error ?? s.error_msg) }
      : s,
    ));
    setExtracting(null);
  }

  return (
    <aside style={{ width: 220, borderRight: '1px solid rgba(31,41,55,0.75)', display: 'flex', flexDirection: 'column', background: 'rgba(13,13,22,0.42)', backdropFilter: 'blur(10px)' }}>
      <div style={{ padding: '10px 10px 10px 14px', borderBottom: '1px solid rgba(31,41,55,0.75)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, background: 'rgba(4,6,26,0.22)' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Sources</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleAdd} style={{ background: '#312e81', border: 'none', borderRadius: 4, padding: '3px 8px', color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>+ PDF</button>
          <button onClick={() => setTextModal(true)} style={{ background: '#1e3a2f', border: 'none', borderRadius: 4, padding: '3px 8px', color: '#6ee7b7', fontSize: 11, cursor: 'pointer' }}>+ Text</button>
          <button
            onClick={() => setCollapsed(true)}
            title="Minimize sources"
            style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '3px 7px', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
          >
            ‹
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sources.length === 0 && (
          <div style={{ padding: 20, color: '#374151', fontSize: 12, textAlign: 'center' }}>No PDFs yet</div>
        )}
        {sources.map(src => {
          const st = STATUS[src.status] ?? STATUS.pending;
          return (
            <div
              key={src.id}
              onClick={() => onSelect(src.id)}
              style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid rgba(17,24,39,0.75)', background: selectedId === src.id ? 'rgba(30,30,46,0.72)' : 'rgba(4,6,26,0.10)', position: 'relative' }}
            >
              <button
                onClick={e => handleDelete(e, src.id)}
                title="Delete source"
                style={{ position: 'absolute', top: 4, right: 6, background: 'none', border: 'none', color: '#4b5563', fontSize: 14, cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}
              >
                ×
              </button>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 16 }}>
                {src.title ?? src.filename}
              </div>
              {src.error_msg && (
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={src.error_msg}>
                  {src.error_msg}
                </div>
              )}
              {!src.error_msg && processSummaries[src.id] && (
                <div style={{ fontSize: 10, color: '#4b5563', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={processSummaries[src.id]}>
                  {processSummaries[src.id]}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: st.color }}>{st.label}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {src.status === 'pending' && (
                    <button
                      onClick={e => handleExtract(e, src.id)}
                      disabled={extracting === src.id}
                      style={{ background: '#1e1e2e', border: '1px solid #374151', borderRadius: 3, padding: '1px 6px', color: '#818cf8', fontSize: 10, cursor: 'pointer' }}
                    >
                      Extract
                    </button>
                  )}
                  {src.status === 'failed' && (
                    <button
                      onClick={e => handleExtract(e, src.id)}
                      disabled={extracting === src.id}
                      style={{ background: '#1e1e2e', border: '1px solid #7f1d1d', borderRadius: 3, padding: '1px 6px', color: '#f87171', fontSize: 10, cursor: 'pointer' }}
                    >
                      Retry
                    </button>
                  )}
                  {src.status === 'ready' && (
                    <button
                      onClick={e => handleExtract(e, src.id)}
                      disabled={extracting === src.id}
                      title="Re-process this source. Wipes derived artifacts (candidates/chunks/concepts without study history) and re-runs the parser. Mastery and evidence_records are preserved."
                      style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 3, padding: '1px 6px', color: '#6b7280', fontSize: 10, cursor: 'pointer' }}
                    >
                      Re-extract
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {pendingDeletes.length > 0 && (
        <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(31,41,55,0.75)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pendingDeletes.map(entry => (
            <div key={`pending-${entry.source.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(13,13,22,0.6)', border: '1px solid #1f2937', borderRadius: 6,
              padding: '7px 9px', fontSize: 11, color: '#94a3b8',
            }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.source.title ?? entry.source.filename}>
                Deleted “{entry.source.title ?? entry.source.filename}”.
              </span>
              <button
                onClick={() => undoDelete(entry)}
                style={{ background: '#1e1b4b', border: '1px solid #6366f1', borderRadius: 4, color: '#c7d2fe', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '3px 9px' }}
              >Undo</button>
            </div>
          ))}
        </div>
      )}
      {textModal && createPortal((
        <div
          onMouseDown={handleTextBackdropClick}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.68)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 24,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Paste Text Source"
            style={{
              width: 'min(1100px, calc(100vw - 72px))',
              height: 'min(820px, calc(100vh - 72px))',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: 'rgba(8, 13, 30, 0.3)',
              border: '1px solid rgba(129, 140, 248, 0.28)',
              borderRadius: 10,
              padding: 18,
              boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
              backdropFilter: 'blur(18px)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#dbeafe' }}>Paste Text Source</div>
                <div style={{ marginTop: 3, fontSize: 11, color: '#64748b' }}>
                  Paste long text, notes, articles, or transcripts.
                </div>
              </div>
              <button
                onClick={closeTextModal}
                title="Close"
                style={{
                  width: 26,
                  height: 26,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(15, 23, 42, 0.36)',
                  border: '1px solid rgba(148, 163, 184, 0.22)',
                  borderRadius: 6,
                  color: '#94a3b8',
                  fontSize: 16,
                  lineHeight: 1,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
            <input
              placeholder="Title (optional)"
              value={textTitle}
              onChange={e => setTextTitle(e.target.value)}
              style={{
                background: 'rgba(15, 23, 42, 0.52)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
                borderRadius: 6,
                padding: '8px 10px',
                color: '#e5e7eb',
                fontSize: 12,
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <textarea
              placeholder="Paste your text here..."
              value={textContent}
              onChange={e => setTextContent(e.target.value)}
              style={{
                flex: 1,
                minHeight: 0,
                background: 'rgba(15, 23, 42, 0.44)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
                borderRadius: 6,
                padding: '10px 12px',
                color: '#e5e7eb',
                fontSize: 12,
                lineHeight: 1.55,
                resize: 'none',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {textCharCount.toLocaleString()} chars / {textWordCount.toLocaleString()} words
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={closeTextModal}
                  title="Cancel"
                  aria-label="Cancel"
                  style={{
                    width: 32,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(15, 23, 42, 0.28)',
                    border: '1px solid rgba(148, 163, 184, 0.24)',
                    borderRadius: 6,
                    padding: '6px 0',
                    color: '#94a3b8',
                    fontSize: 15, lineHeight: 1,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
                <button
                  onClick={handleAddText}
                  disabled={!textContent.trim()}
                  style={{
                    background: textContent.trim() ? 'rgba(79, 70, 229, 0.74)' : 'rgba(30, 41, 59, 0.36)',
                    border: `1px solid ${textContent.trim() ? 'rgba(129, 140, 248, 0.76)' : 'rgba(71, 85, 105, 0.42)'}`,
                    borderRadius: 6,
                    padding: '6px 16px',
                    color: textContent.trim() ? '#dbeafe' : '#64748b',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: textContent.trim() ? 'pointer' : 'not-allowed',
                    boxShadow: textContent.trim() ? '0 0 18px rgba(79, 70, 229, 0.18)' : 'none',
                  }}
                >
                  Add Source
                </button>
              </div>
            </div>
          </div>
        </div>
      ), document.body)}
    </aside>
  );
}
