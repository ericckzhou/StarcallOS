import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
const EVIDENCE_RAIL_KEY = 'starcall.layout.evidenceRailCollapsed';
const ZOOM_KEY          = 'starcall.layout.pdfZoom';
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 3.0;
const ZOOM_STEP = 0.1;

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
  const [evidenceRailCollapsed, setEvidenceRailCollapsed] = useState(() => localStorage.getItem(EVIDENCE_RAIL_KEY) === 'true');
  const [userZoom, setUserZoom] = useState<number>(() => {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(stored) && stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : 1.0;
  });
  const [fitScale, setFitScale] = useState<number>(1.0);
  const [intrinsicPageWidth, setIntrinsicPageWidth] = useState<number | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const initialScrollPageRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem(EVIDENCE_RAIL_KEY, String(evidenceRailCollapsed));
  }, [evidenceRailCollapsed]);

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(userZoom));
  }, [userZoom]);

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
    setIntrinsicPageWidth(null);
    pageRefs.current.clear();
    initialScrollPageRef.current = null;
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
          // Cache page-1 width at scale=1 so we can compute fit-to-width as
          // soon as we know the container width.
          try {
            const p1 = await doc.getPage(1);
            if (!cancelled) {
              setIntrinsicPageWidth(p1.getViewport({ scale: 1 }).width);
            }
          } catch {
            // intrinsic width is a nice-to-have; PdfPage's own measurement
            // covers the layout even if this fails.
          }
          const startPage = meta.evidence[0]?.page ?? 1;
          setPage(startPage);
          initialScrollPageRef.current = startPage;
        } else {
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

  // Measure the scroll container width and derive fit-to-width scale. Updates
  // on container resize (e.g. user drags the split divider).
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || intrinsicPageWidth == null || intrinsicPageWidth === 0) return;
    const compute = () => {
      // -2 to dodge the 1px scrollbar gutter on Windows.
      const w = el.clientWidth - 2;
      if (w <= 0) return;
      setFitScale(w / intrinsicPageWidth);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [intrinsicPageWidth]);

  const renderScale = fitScale * userZoom;

  // Initial scroll to first evidence page once layout has settled. Each
  // PdfPage measures its intrinsic size asynchronously (one getPage call
  // per page through pdfjs's worker). For a 1108-page book scrolling to
  // page 257 means waiting on 257 of those measurements to land — way
  // longer than a fixed RAF poll. Use a ResizeObserver on the scroll
  // container so we re-check every time a page measurement extends the
  // total content height, and a hard 30s timeout as a final fallback.
  useEffect(() => {
    if (!pdfDoc) return;
    const target = initialScrollPageRef.current;
    if (target == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let done = false;
    const tryScroll = () => {
      if (done) return;
      const el = pageRefs.current.get(target);
      if (!el || el.offsetHeight === 0) return;
      for (let p = 1; p <= target; p++) {
        const wrap = pageRefs.current.get(p);
        if (!wrap || wrap.offsetHeight === 0) return; // not ready
      }
      done = true;
      el.scrollIntoView({ block: 'start', behavior: 'auto' });
      initialScrollPageRef.current = null;
    };

    // Initial attempt + watch for layout extension as pages measure in.
    tryScroll();
    const ro = new ResizeObserver(tryScroll);
    ro.observe(container);
    for (const el of pageRefs.current.values()) ro.observe(el);

    // 30s safety net: scroll best-effort even if not every page above target
    // has measured. Lands close enough that the user can finish manually.
    const timeoutId = window.setTimeout(() => {
      if (done) return;
      done = true;
      const el = pageRefs.current.get(target);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
      initialScrollPageRef.current = null;
      ro.disconnect();
    }, 30_000);

    return () => {
      ro.disconnect();
      window.clearTimeout(timeoutId);
      // No-op marker so the closure stops invoking after unmount.
      done = true;
    };
  }, [pdfDoc]);

  // Track currently visible page based on scroll position.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerTop = container.scrollTop;
    let bestPage = 1;
    let bestDelta = Infinity;
    for (const [pageNum, el] of pageRefs.current.entries()) {
      const delta = Math.abs(el.offsetTop - containerTop);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestPage = pageNum;
      }
    }
    setPage(prev => (prev === bestPage ? prev : bestPage));
  }, []);

  const registerPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNum, el);
    else pageRefs.current.delete(pageNum);
  }, []);

  function scrollToPage(targetPage: number): void {
    const el = pageRefs.current.get(targetPage);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function zoomIn():   void { setUserZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))); }
  function zoomOut():  void { setUserZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))); }
  function zoomReset(): void { setUserZoom(1.0); }

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
  const visibleEvidenceList = evidenceOnly && evidencePages.length > 0
    ? data.evidence.filter(e => evidencePages.includes(e.page))
    : data.evidence;

  function goPrevEvidence(): void {
    const prior = [...evidencePages].reverse().find(p => p < page);
    if (prior != null) scrollToPage(prior);
  }
  function goNextEvidence(): void {
    const next = evidencePages.find(p => p > page);
    if (next != null) scrollToPage(next);
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
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Side rail of evidence chips */}
      <aside style={{
        width: evidenceRailCollapsed ? 36 : 260, borderRight: '1px solid #1f2937', background: '#0d0d16',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', alignItems: evidenceRailCollapsed ? 'center' : 'stretch',
        flexShrink: 0,
      }}>
        {evidenceRailCollapsed ? (
          <button
            onClick={() => setEvidenceRailCollapsed(false)}
            title={`Evidence (${data.evidence.length}) - click to expand`}
            style={{
              marginTop: 8, background: 'transparent', border: '1px solid #1f2937', borderRadius: 3,
              color: '#fbbf24', fontSize: 12, padding: '4px 6px', cursor: 'pointer',
              writingMode: 'vertical-rl', textOrientation: 'mixed',
            }}
          >
            Evidence ({data.evidence.length})
          </button>
        ) : (
          <>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #1f2937' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Evidence ({data.evidence.length})
                </div>
                <button
                  onClick={() => setEvidenceRailCollapsed(true)}
                  title="Minimize evidence rail"
                  style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '2px 7px', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                >
                  ‹
                </button>
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
                      onClick={() => scrollToPage(e.page)}
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
          </>
        )}
      </aside>

      {/* PDF render area — continuous vertical scroll, fit-to-width, zoomable */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Header data={data} conceptName={conceptName} extras={
          <>
            <button onClick={zoomOut} title="Zoom out" style={navBtnStyle}>−</button>
            <button onClick={zoomReset} title="Reset zoom to fit width" style={navBtnStyle}>
              {Math.round(userZoom * 100)}%
            </button>
            <button onClick={zoomIn} title="Zoom in" style={navBtnStyle}>+</button>
            <span style={{ width: 8 }} />
            <button onClick={goPrevEvidence} title="Previous evidence page" style={navBtnEvidenceStyle}>« Ev</button>
            <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 100, textAlign: 'center' }}>
              Page {page} / {totalPages}
            </span>
            <button onClick={goNextEvidence} title="Next evidence page" style={navBtnEvidenceStyle}>Ev »</button>
          </>
        } />
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            flex: 1, overflow: 'auto', background: '#000',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: 0, gap: 8,
          }}
        >
          {pdfDoc && intrinsicPageWidth != null && Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
            <PdfPage
              key={pageNum}
              doc={pdfDoc}
              pageNum={pageNum}
              scale={renderScale}
              registerRef={registerPageRef}
              scrollContainerRef={scrollContainerRef}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// One page in the stack. Reserves vertical space immediately from the
// intrinsic page size at the current scale, lazy-renders its canvas +
// selectable text layer when scrolled into view, and re-renders whenever
// the scale changes (fit-to-width recompute or user zoom).
function PdfPage({
  doc, pageNum, scale, registerRef, scrollContainerRef,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  registerRef: (pageNum: number, el: HTMLDivElement | null) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);

  // Recompute reserved size whenever scale changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await doc.getPage(pageNum);
        if (cancelled) return;
        const vp = p.getViewport({ scale });
        setSize({ width: vp.width, height: vp.height });
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [doc, pageNum, scale]);

  // Visibility tracking via IntersectionObserver scoped to the scroll container.
  // ±400px rootMargin gives a smoother scroll.
  useEffect(() => {
    const root = scrollContainerRef.current;
    const el = wrapperRef.current;
    if (!root || !el) return;
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root, rootMargin: '400px 0px', threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollContainerRef, size]);

  // Render canvas + selectable text layer when visible at current scale.
  useEffect(() => {
    if (!visible || !size || !canvasRef.current) {
      renderTaskRef.current?.cancel();
      textTaskRef.current?.cancel();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        renderTaskRef.current?.cancel();
        textTaskRef.current?.cancel();
        const p = await doc.getPage(pageNum);
        if (cancelled) return;
        const vp = p.getViewport({ scale });
        const canvas = canvasRef.current!;
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.floor(vp.width  * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width  = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = p.render({ canvasContext: ctx, viewport: vp });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;

        // Text layer for selection / copy.
        const textLayerEl = textLayerRef.current;
        if (textLayerEl) {
          textLayerEl.innerHTML = '';
          textLayerEl.style.width  = `${vp.width}px`;
          textLayerEl.style.height = `${vp.height}px`;
          textLayerEl.style.setProperty('--scale-factor', String(vp.scale));
          const textContent = await p.getTextContent();
          if (cancelled) return;
          // renderTextLayer signature varies slightly across pdfjs versions;
          // the legacy/build supports { textContentSource, container, viewport }.
          const textTask = (pdfjs as unknown as {
            renderTextLayer: (args: {
              textContentSource: unknown;
              container: HTMLElement;
              viewport: unknown;
            }) => { promise: Promise<void>; cancel: () => void };
          }).renderTextLayer({
            textContentSource: textContent,
            container: textLayerEl,
            viewport: vp,
          });
          textTaskRef.current = textTask;
          try { await textTask.promise; } catch { /* cancelled mid-render is fine */ }
        }
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== 'RenderingCancelledException') {
          console.error(`[PdfViewer] render error on page ${pageNum}`, e);
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      textTaskRef.current?.cancel();
    };
  }, [doc, pageNum, visible, size, scale]);

  return (
    <div
      ref={el => {
        wrapperRef.current = el;
        registerRef(pageNum, el);
      }}
      data-page-num={pageNum}
      style={{
        width: size?.width,
        height: size?.height,
        background: '#fff',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {visible && size && (
        <>
          <canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', top: 0, left: 0 }} />
          <div
            ref={textLayerRef}
            className="pdf-text-layer"
            style={{
              position: 'absolute', top: 0, left: 0,
              overflow: 'hidden', opacity: 0.999,
              lineHeight: 1, color: 'transparent',
              userSelect: 'text', cursor: 'text',
            }}
          />
        </>
      )}
      {!visible && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#9ca3af', fontSize: 12,
        }}>
          p.{pageNum}
        </div>
      )}
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
  padding: '3px 8px', fontSize: 11, color: '#9ca3af', cursor: 'pointer',
  minWidth: 28, textAlign: 'center',
};

const panelStyle: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#6b7280', fontSize: 13,
};
