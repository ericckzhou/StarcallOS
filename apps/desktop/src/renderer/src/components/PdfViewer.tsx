import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as pdfjs from 'pdfjs-dist';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vite ?url import returns a string path the worker loader uses
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl as unknown as string;

interface Evidence {
  page: number;
  kind: string;
  label: string;
  quote?: string;
}

interface SourceEvidence {
  sourceId: number;
  filePath: string;
  filename: string;
  pageCount: number | null;
  isPdf: boolean;
  evidence: Evidence[];
}

const KIND_COLOR: Record<string, string> = {
  heading:    '#f59e0b',
  definition: '#22c55e',
  equation:   '#fbbf24',
  relation:   '#a855f7',
  chunk:      '#818cf8',
  first_page: '#6b7280',
};

interface Props {
  conceptId: number;
  conceptName: string;
}

export default function PdfViewer({ conceptId, conceptName }: Props) {
  const [data, setData] = useState<SourceEvidence | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [evidenceOnly, setEvidenceOnly] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [renderingPage, setRenderingPage] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

  // Pages that have any evidence (deduped + sorted)
  const evidencePages = useMemo(() => {
    if (!data) return [] as number[];
    return [...new Set(data.evidence.map(e => e.page))].sort((a, b) => a - b);
  }, [data]);

  // Load metadata + bytes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setTextBody(null);
    setPdfDoc(null);
    (async () => {
      try {
        const meta = await window.api.concepts.sourceEvidence(conceptId);
        if (cancelled || !meta) return;
        setData(meta);
        if (meta.isPdf) {
          const bytes = await window.api.sources.bytes(meta.sourceId);
          if (cancelled) return;
          const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
          if (cancelled) { doc.destroy(); return; }
          setPdfDoc(doc);
          setPage(meta.evidence[0]?.page ?? 1);
        } else {
          // Plain-text source: fetch raw text by re-reading via the bytes endpoint
          const bytes = await window.api.sources.bytes(meta.sourceId);
          if (cancelled) return;
          setTextBody(new TextDecoder('utf-8').decode(new Uint8Array(bytes)));
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [conceptId]);

  // Render current page when pdfDoc or page changes
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    setRenderingPage(true);
    (async () => {
      try {
        renderTaskRef.current?.cancel();
        const pdfPage = await pdfDoc.getPage(page);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== 'RenderingCancelledException') {
          console.error('[PdfViewer] render error', e);
        }
      } finally {
        if (!cancelled) setRenderingPage(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, page]);

  if (loading) {
    return <div style={panelStyle}>Loading source…</div>;
  }
  if (err) {
    return <div style={{ ...panelStyle, color: '#fca5a5' }}>Failed to load source: {err}</div>;
  }
  if (!data) {
    return <div style={panelStyle}>No source available for this concept.</div>;
  }

  // Plain-text source view
  if (!data.isPdf) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <Header data={data} conceptName={conceptName} extras={null} />
        <pre style={{
          flex: 1, margin: 0, padding: 20, overflow: 'auto',
          background: '#0d0d16', color: '#d1d5db', fontSize: 12, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace',
        }}>
          {textBody ?? '(empty)'}
        </pre>
      </div>
    );
  }

  const totalPages = pdfDoc?.numPages ?? data.pageCount ?? 1;
  // Side rail filter (controlled by "Evidence pages only" checkbox) is
  // independent of page navigation — Prev/Next always step ±1 literal page
  // so you can read what comes after an evidence span.
  const visibleEvidenceList = evidenceOnly && evidencePages.length > 0
    ? data.evidence.filter(e => evidencePages.includes(e.page))
    : data.evidence;

  function goPrev(): void { if (page > 1) setPage(page - 1); }
  function goNext(): void { if (page < totalPages) setPage(page + 1); }
  function goPrevEvidence(): void {
    const prior = [...evidencePages].reverse().find(p => p < page);
    if (prior != null) setPage(prior);
  }
  function goNextEvidence(): void {
    const next = evidencePages.find(p => p > page);
    if (next != null) setPage(next);
  }
  async function deleteEvidenceSpan(targetPage: number, kind: string, quote: string): Promise<void> {
    try {
      const updated = await window.api.concepts.deleteEvidenceSpan({
        conceptId, page: targetPage, kind, quote,
      });
      if (updated) setData(updated);
    } catch (e) {
      console.error('[PdfViewer] deleteEvidenceSpan failed', e);
    }
  }
  const evidenceOnThisPage = data.evidence.filter(e => e.page === page);

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Side rail of evidence chips */}
      <aside style={{
        width: 260, borderRight: '1px solid #1f2937', background: '#0d0d16',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #1f2937' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
            Evidence ({data.evidence.length})
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9ca3af', cursor: 'pointer' }}>
            <input
              type="checkbox" checked={evidenceOnly}
              onChange={e => setEvidenceOnly(e.target.checked)}
              style={{ accentColor: '#818cf8' }}
            />
            Evidence pages only ({evidencePages.length})
          </label>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visibleEvidenceList.map((e, i) => {
            const color = KIND_COLOR[e.kind] ?? '#6b7280';
            const selected = e.page === page;
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'stretch',
                background: selected ? '#1a1a2e' : 'transparent',
                borderLeft: `3px solid ${selected ? color : 'transparent'}`,
                borderBottom: '1px solid #111827',
              }}>
                <button
                  onClick={() => setPage(e.page)}
                  style={{
                    flex: 1, textAlign: 'left',
                    background: 'transparent', border: 'none',
                    padding: '8px 12px', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af' }}>p.{e.page}</span>
                    <span style={{ fontSize: 9, color, border: `1px solid ${color}`, borderRadius: 2, padding: '1px 5px', textTransform: 'uppercase' }}>
                      {e.label}
                    </span>
                  </div>
                  {e.quote && (
                    <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      “{e.quote}”
                    </div>
                  )}
                </button>
                <button
                  onClick={() => void deleteEvidenceSpan(e.page, e.kind, e.quote ?? '')}
                  title="Remove this evidence span from the concept"
                  style={{
                    background: 'transparent', border: 'none', color: '#4b5563',
                    padding: '0 8px', fontSize: 14, cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {visibleEvidenceList.length === 0 && (
            <div style={{ padding: 20, color: '#374151', fontSize: 11, textAlign: 'center' }}>
              No evidence to show. Uncheck "Evidence pages only" to see more.
            </div>
          )}
        </div>
      </aside>

      {/* PDF render area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Header data={data} conceptName={conceptName} extras={
          <>
            <button onClick={goPrevEvidence} title="Previous evidence page" style={navBtnEvidenceStyle}>« Ev</button>
            <button onClick={goPrev} title="Previous page" style={navBtnStyle}>‹ Prev</button>
            <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 100, textAlign: 'center' }}>
              Page {page} / {totalPages}
            </span>
            <button onClick={goNext} title="Next page" style={navBtnStyle}>Next ›</button>
            <button onClick={goNextEvidence} title="Next evidence page" style={navBtnEvidenceStyle}>Ev »</button>
            {renderingPage && <span style={{ fontSize: 10, color: '#6b7280' }}>rendering…</span>}
          </>
        } />
        {evidenceOnThisPage.length > 0 && (
          <div style={{ padding: '6px 14px', borderBottom: '1px solid #1f2937', background: '#0d0d16', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {evidenceOnThisPage.map((e, i) => (
              <span key={i} style={{
                fontSize: 10, color: KIND_COLOR[e.kind] ?? '#6b7280',
                border: `1px solid ${KIND_COLOR[e.kind] ?? '#374151'}`,
                borderRadius: 2, padding: '1px 5px',
              }}>
                {e.label}
              </span>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', background: '#000', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 16 }}>
          <canvas ref={canvasRef} style={{ background: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }} />
        </div>
      </div>
    </div>
  );
}

function Header({ data, conceptName, extras }: { data: SourceEvidence; conceptName: string; extras: React.ReactNode }) {
  return (
    <div style={{
      padding: '8px 14px', borderBottom: '1px solid #1f2937', background: '#0d0d16',
      display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{conceptName}</span>
      <span style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
        {data.filename}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{extras}</div>
    </div>
  );
}

const navBtnEvidenceStyle: React.CSSProperties = {
  background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 3,
  padding: '3px 8px', fontSize: 11, color: '#c7d2fe', cursor: 'pointer', fontWeight: 600,
};

const navBtnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid #1f2937', borderRadius: 3,
  padding: '3px 10px', fontSize: 11, color: '#9ca3af', cursor: 'pointer',
};

const panelStyle: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#6b7280', fontSize: 13,
};
