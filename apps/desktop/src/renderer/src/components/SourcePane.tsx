import React, { useEffect, useState } from 'react';

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

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

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
    const source = await window.api.sources.create({});
    if (source) onSourcesChange([...sources, source as Source]);
  }

  async function handleAddText() {
    if (!textContent.trim()) return;
    const source = await (window.api.sources as any).createText({ text: textContent.trim(), title: textTitle.trim() || undefined });
    if (source) onSourcesChange([...sources, source as Source]);
    setTextModal(false);
    setTextContent('');
    setTextTitle('');
  }

  async function handleDelete(e: React.MouseEvent, sourceId: number) {
    e.stopPropagation();
    await window.api.sources.delete(sourceId);
    onSourcesChange(sources.filter(s => s.id !== sourceId));
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
      {textModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 8, padding: 20, width: 480, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#a5b4fc' }}>Paste Text Source</div>
            <input
              placeholder="Title (optional)"
              value={textTitle}
              onChange={e => setTextTitle(e.target.value)}
              style={{ background: '#111827', border: '1px solid #374151', borderRadius: 4, padding: '6px 10px', color: '#e5e7eb', fontSize: 12, outline: 'none' }}
            />
            <textarea
              placeholder="Paste your text here…"
              value={textContent}
              onChange={e => setTextContent(e.target.value)}
              rows={10}
              style={{ background: '#111827', border: '1px solid #374151', borderRadius: 4, padding: '6px 10px', color: '#e5e7eb', fontSize: 12, resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setTextModal(false); setTextContent(''); setTextTitle(''); }} style={{ background: 'none', border: '1px solid #374151', borderRadius: 4, padding: '5px 14px', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleAddText} disabled={!textContent.trim()} style={{ background: '#312e81', border: 'none', borderRadius: 4, padding: '5px 14px', color: '#a5b4fc', fontSize: 12, cursor: 'pointer' }}>Add Source</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
