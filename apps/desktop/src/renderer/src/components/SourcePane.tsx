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
  origin_url?: string | null;
};

interface Props {
  sources: Source[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onSourcesChange: (sources: Source[]) => void;
}

// Bulk-export trigger: a small download button that opens a Markdown/Anki menu
// and exports either one source's concepts (scope 'source') or the whole
// library (scope 'library') via export:bundle. The main process owns the Save
// dialog and file write. Mirrors the per-concept ExportButton in DetailPane.
function BundleExportButton(
  { scope, sourceId, title, size = 'row' }: {
    scope: 'source' | 'library';
    sourceId?: number;
    title: string;
    size?: 'row' | 'header';
  },
) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const btnRef = useRef<HTMLButtonElement>(null);
  // The menu is portaled to <body> with fixed coords so the narrow Sources
  // sidebar (220px, overflow:auto) can't clip it. Anchored bottom-right of the
  // trigger, clamped into the viewport.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_WIDTH = 172;

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      setMenuPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    // The fixed menu doesn't track scroll, so close it on scroll/resize instead.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function doExport(format: 'markdown' | 'anki') {
    setOpen(false);
    setStatus('saving');
    void window.api.export.bundle({ scope, sourceId, format })
      .then(res => {
        if (res.ok) { setStatus('saved'); setTimeout(() => setStatus('idle'), 1600); }
        else if (res.canceled) { setStatus('idle'); }
        else { setStatus('error'); setTimeout(() => setStatus('idle'), 2400); }
      })
      .catch(() => { setStatus('error'); setTimeout(() => setStatus('idle'), 2400); });
  }

  const tint = status === 'saved' ? '#34d399' : status === 'error' ? '#f87171' : (open ? '#a5b4fc' : '#6b7280');
  const optStyle: React.CSSProperties = {
    width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'transparent', border: '1px solid rgba(129,140,248,0.28)', borderRadius: 6,
    padding: '6px 9px', marginTop: 6, fontSize: 11, color: '#c7d2fe', cursor: 'pointer',
  };
  const extStyle: React.CSSProperties = { fontSize: 9, color: '#64748b', fontVariantNumeric: 'tabular-nums' };
  const btnDim = size === 'header' ? 23 : 18;
  const iconDim = size === 'header' ? 12 : 11;

  return (
    <div style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
      <button
        ref={btnRef}
        onClick={e => { e.stopPropagation(); if (open) setOpen(false); else openMenu(); }}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={status === 'saving'}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: btnDim, height: btnDim, background: open ? 'rgba(129,140,248,0.12)' : 'transparent',
          border: `1px solid ${open ? 'rgba(129,140,248,0.5)' : '#1f2937'}`, borderRadius: 3,
          color: tint, cursor: status === 'saving' ? 'default' : 'pointer',
        }}
      >
        {status === 'saved' ? (
          <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
        ) : (
          <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
        )}
      </button>
      {open && menuPos && createPortal((
        <div role="menu" onClick={e => e.stopPropagation()} style={{
          position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 200, width: MENU_WIDTH,
          background: 'rgba(4,6,26,0.5)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid #263244', borderRadius: 8, boxShadow: '0 14px 34px rgba(0,0,0,0.6)', padding: 9,
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '0 2px' }}>
            Export {scope === 'library' ? 'library' : 'source'} as
          </div>
          <button className="rel-opt" role="menuitem" onClick={e => { e.stopPropagation(); doExport('markdown'); }} title="Export as Markdown (.md)" style={optStyle}>
            <span>Markdown</span><span style={extStyle}>.md</span>
          </button>
          <button className="rel-opt" role="menuitem" onClick={e => { e.stopPropagation(); doExport('anki'); }} title="Export as an Anki import file (.txt, tab-separated)" style={optStyle}>
            <span>Anki</span><span style={extStyle}>.txt</span>
          </button>
        </div>
      ), document.body)}
    </div>
  );
}

interface AddItem { key: string; label: string; hint: string; color: string; icon: React.ReactNode; onClick: () => void; }

// Consolidated "+ Add" source control: one button → a portaled menu of source
// types (PDF / Text / URL / Document). Portaled to <body> so the narrow Sources
// sidebar can't clip it; closes on outside-click, Escape, scroll, or resize.
function AddSourceMenu({ items }: { items: AddItem[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const WIDTH = 200;

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        onClick={e => { e.stopPropagation(); if (open) setOpen(false); else openMenu(); }}
        title="Add a source"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: open ? '#3730a3' : '#312e81', border: '1px solid #4338ca', borderRadius: 4,
          padding: '3px 9px', color: '#c7d2fe', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          transition: 'background 160ms',
        }}
      >
        + Add
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal((
        <div role="menu" aria-label="Add source" onClick={e => e.stopPropagation()} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 200, width: WIDTH,
          background: 'rgba(4,6,26,0.5)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid #263244', borderRadius: 8, boxShadow: '0 14px 34px rgba(0,0,0,0.6)', padding: 7,
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '2px 6px 5px' }}>Add source</div>
          {items.map(it => (
            <button key={it.key} className="rel-opt" role="menuitem" title={it.label}
              onClick={e => { e.stopPropagation(); setOpen(false); it.onClick(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 6, padding: '7px 8px', color: '#cbd5e1', fontSize: 12, cursor: 'pointer' }}>
              <span style={{ color: it.color, display: 'inline-flex', flexShrink: 0 }} aria-hidden="true">{it.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
              <span style={{ fontSize: 9, color: '#475569', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{it.hint}</span>
            </button>
          ))}
        </div>
      ), document.body)}
    </div>
  );
}

// Compact 16px source-type icons (stroke, inherit color).
const IconPdf = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
const IconText = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h10" /></svg>;
const IconUrl = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" /></svg>;
const IconDoc = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>;

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
  const [urlModal, setUrlModal] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlTitle, setUrlTitle] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [processSummaries, setProcessSummaries] = useState<Record<number, string>>({});
  // Deleting a source cascades away concepts/evidence/XP, so we defer the real
  // delete behind a 5s undo window instead of a confirm popup. Nothing is
  // destroyed until the timer fires — undo just cancels it and restores the row.
  const [pendingDeletes, setPendingDeletes] = useState<{ source: Source; index: number }[]>([]);
  const deleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // On unmount (e.g. switching to Review/Map within the 5s undo window), FLUSH
  // pending source deletes instead of cancelling them — otherwise the source is
  // dropped from the list optimistically but never deleted in the DB, leaving
  // its concepts/map orphaned.
  const pendingDeletesRef = useRef(pendingDeletes);
  pendingDeletesRef.current = pendingDeletes;
  useEffect(() => () => {
    for (const t of deleteTimers.current.values()) clearTimeout(t);
    if (pendingDeletesRef.current.length > 0) {
      for (const { source } of pendingDeletesRef.current) {
        void window.api.sources.delete(source.id).catch(e => console.error('[starcall:ipc] sources.delete flush', e));
      }
      window.dispatchEvent(new Event('starcall:progressChanged'));
      window.dispatchEvent(new Event('starcall:review-queue-stale'));
    }
  }, []);

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

  function closeUrlModal() {
    setUrlModal(false);
    setUrlValue('');
    setUrlTitle('');
    setUrlError(null);
    setUrlBusy(false);
  }

  async function handleImportUrl() {
    const url = urlValue.trim();
    if (!url || urlBusy) return;
    setUrlBusy(true);
    setUrlError(null);
    try {
      const res = await window.api.sources.importUrl({ url, title: urlTitle.trim() || undefined });
      if (res.ok && res.source) {
        onSourcesChange([...sources, res.source as Source]);
        closeUrlModal();
      } else {
        setUrlError(res.error ?? 'Import failed.');
        setUrlBusy(false);
      }
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : String(e));
      setUrlBusy(false);
    }
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

  async function handleAddDoc() {
    setDocMsg(null);
    const res = await window.api.sources.importDocs({}); // main opens the file dialog
    if (res.sources.length > 0) onSourcesChange([...sources, ...(res.sources as Source[])]);
    if (res.errors.length > 0) {
      console.error('[starcall:ipc] importDocs errors', res.errors);
      const added = res.sources.length;
      setDocMsg(`${res.errors.length} file${res.errors.length === 1 ? '' : 's'} failed${added ? ` · ${added} imported` : ''}.`);
      setTimeout(() => setDocMsg(null), 5000);
    }
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
      void window.api.sources.delete(sourceId)
        .then(() => {
          window.dispatchEvent(new Event('starcall:progressChanged'));
          window.dispatchEvent(new Event('starcall:review-queue-stale'));
        })
        .catch(e => console.error('[starcall:ipc] sources.delete', e));
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
          <AddSourceMenu items={[
            { key: 'pdf', label: 'PDF', hint: '.pdf', color: '#a5b4fc', icon: IconPdf, onClick: () => void handleAdd() },
            { key: 'text', label: 'Text', hint: 'paste', color: '#6ee7b7', icon: IconText, onClick: () => setTextModal(true) },
            { key: 'url', label: 'Web page', hint: 'URL', color: '#7dd3fc', icon: IconUrl, onClick: () => setUrlModal(true) },
            { key: 'doc', label: 'Document', hint: '.docx · .pptx', color: '#d8b4fe', icon: IconDoc, onClick: () => void handleAddDoc() },
          ]} />
          <button
            onClick={() => setCollapsed(true)}
            title="Minimize sources"
            style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '3px 7px', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
          >
            ‹
          </button>
        </div>
      </div>
      {docMsg && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: '#fca5a5', background: 'rgba(127,29,29,0.18)', borderBottom: '1px solid rgba(31,41,55,0.75)' }}>
          {docMsg}
        </div>
      )}
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
                  {src.origin_url && (
                    <button
                      onClick={e => { e.stopPropagation(); void window.api.app.openExternal(src.origin_url!); }}
                      title={`Open original page: ${src.origin_url}`}
                      aria-label="Open original page in browser"
                      style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 3, padding: '1px 6px', color: '#7dd3fc', fontSize: 10, cursor: 'pointer' }}
                    >
                      Open ↗
                    </button>
                  )}
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
                    <BundleExportButton scope="source" sourceId={src.id} title="Export this source's concepts (Markdown / Anki)" />
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
      {urlModal && createPortal((
        <div
          onMouseDown={e => { if (e.target === e.currentTarget && !urlValue.trim() && !urlTitle.trim()) closeUrlModal(); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.68)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24 }}
        >
          <div
            role="dialog" aria-modal="true" aria-label="Import URL"
            onKeyDown={e => { if (e.key === 'Escape') closeUrlModal(); }}
            style={{
              width: 'min(560px, calc(100vw - 72px))', boxSizing: 'border-box',
              display: 'flex', flexDirection: 'column', gap: 12,
              background: 'rgba(8, 13, 30, 0.32)', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: 10,
              padding: 18, boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(18px)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#e0f2fe' }}>Import from URL</div>
                <div style={{ marginTop: 3, fontSize: 11, color: '#64748b' }}>
                  Fetches the page and extracts its readable text as a new source. No page geometry, so candidate quality is typically lower than a PDF.
                </div>
              </div>
              <button onClick={closeUrlModal} title="Close" aria-label="Close"
                style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15, 23, 42, 0.36)', border: '1px solid rgba(148, 163, 184, 0.22)', borderRadius: 6, color: '#94a3b8', fontSize: 16, lineHeight: 1, cursor: 'pointer', flexShrink: 0 }}>×</button>
            </div>
            <input
              autoFocus type="url" inputMode="url" placeholder="https://example.com/article"
              value={urlValue} onChange={e => { setUrlValue(e.target.value); setUrlError(null); }}
              onKeyDown={e => { if (e.key === 'Enter') void handleImportUrl(); }}
              style={{ background: 'rgba(15, 23, 42, 0.52)', border: '1px solid rgba(148, 163, 184, 0.22)', borderRadius: 6, padding: '8px 10px', color: '#e5e7eb', fontSize: 12, outline: 'none', fontFamily: 'inherit' }}
            />
            <input
              placeholder="Title (optional — defaults to the page title)"
              value={urlTitle} onChange={e => setUrlTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleImportUrl(); }}
              style={{ background: 'rgba(15, 23, 42, 0.44)', border: '1px solid rgba(148, 163, 184, 0.22)', borderRadius: 6, padding: '8px 10px', color: '#e5e7eb', fontSize: 12, outline: 'none', fontFamily: 'inherit' }}
            />
            {urlError && <div style={{ fontSize: 11, color: '#fca5a5' }}>{urlError}</div>}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={closeUrlModal} title="Cancel" aria-label="Cancel"
                style={{ width: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15, 23, 42, 0.28)', border: '1px solid rgba(148, 163, 184, 0.24)', borderRadius: 6, padding: '6px 0', color: '#94a3b8', fontSize: 15, lineHeight: 1, cursor: 'pointer' }}>×</button>
              <button
                onClick={() => void handleImportUrl()} disabled={!urlValue.trim() || urlBusy}
                style={{
                  background: urlValue.trim() && !urlBusy ? 'rgba(2, 132, 199, 0.74)' : 'rgba(30, 41, 59, 0.36)',
                  border: `1px solid ${urlValue.trim() && !urlBusy ? 'rgba(56, 189, 248, 0.76)' : 'rgba(71, 85, 105, 0.42)'}`,
                  borderRadius: 6, padding: '6px 16px', color: urlValue.trim() && !urlBusy ? '#e0f2fe' : '#64748b',
                  fontSize: 12, fontWeight: 700, cursor: urlValue.trim() && !urlBusy ? 'pointer' : 'not-allowed',
                }}
              >
                {urlBusy ? 'Fetching…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
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
