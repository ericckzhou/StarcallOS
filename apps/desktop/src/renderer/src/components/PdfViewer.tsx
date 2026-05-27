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

interface SavedPdfViewState {
  page: number;
  scrollTop: number;
}

interface Props {
  conceptId: number;
  conceptName: string;
  stabilityKey?: string;
}

export default function PdfViewer({ conceptId, conceptName, stabilityKey }: Props) {
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
  const [intrinsicPageSize, setIntrinsicPageSize] = useState<{ width: number; height: number } | null>(null);
  const renderScale = fitScale * userZoom;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const initialScrollPageRef = useRef<number | null>(null);
  const hasRestoredInitialScrollRef = useRef(false);
  const currentPageRef = useRef(1);
  const currentPageOffsetRef = useRef(0);
  const currentPageOffsetRatioRef = useRef(0);
  const scaleBeforeResizeRef = useRef(renderScale);
  const fitScaleInitializedRef = useRef(false);
  // Tracks which pages have completed their async size measurement. Drives
  // the initial-scroll attempt (event-driven, not RAF polling).
  const measuredPagesRef = useRef<Set<number>>(new Set());
  const onPageMeasuredRef = useRef<((pageNum: number) => void) | null>(null);

  useEffect(() => {
    localStorage.setItem(EVIDENCE_RAIL_KEY, String(evidenceRailCollapsed));
  }, [evidenceRailCollapsed]);

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(userZoom));
  }, [userZoom]);

  const viewStateKey = useMemo(() => `starcall.pdfView.${conceptId}`, [conceptId]);

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
    setIntrinsicPageSize(null);
    fitScaleInitializedRef.current = false;
    pageRefs.current.clear();
    measuredPagesRef.current.clear();
    initialScrollPageRef.current = null;
    hasRestoredInitialScrollRef.current = false;
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
          // Cache page-1 size at scale=1 so every page can reserve an estimated
          // box before its own async measurement finishes. Without this,
          // deep evidence pages briefly collapse near the top and the header can
          // say p.552 while the visible canvas is still somewhere else.
          try {
            const p1 = await doc.getPage(1);
            if (!cancelled) {
              const vp = p1.getViewport({ scale: 1 });
              setIntrinsicPageSize({ width: vp.width, height: vp.height });
            }
          } catch {
            // intrinsic size is a nice-to-have; PdfPage's own measurement
            // covers the layout even if this fails.
          }
          const firstEvidencePage = meta.evidence[0]?.page ?? 1;
          const startPage = clampPage(firstEvidencePage, doc.numPages);
          setPage(startPage);
          currentPageRef.current = startPage;
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
  }, [conceptId, viewStateKey]);

  const computeFitScaleFromContainer = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || intrinsicPageSize == null || intrinsicPageSize.width === 0) return false;
    // -2 to dodge the 1px scrollbar gutter on Windows.
    const w = el.clientWidth - 2;
    if (w <= 0) return false;
    setFitScale(w / intrinsicPageSize.width);
    return true;
  }, [intrinsicPageSize]);

  // Fit the PDF once when it opens. After that, evidence rail toggles and
  // split-pane width changes must not mutate page height; otherwise the same
  // scrollTop lands several pages away. The zoom reset button is the explicit
  // way to refit to the current width.
  useLayoutEffect(() => {
    if (fitScaleInitializedRef.current) return;
    const compute = () => {
      if (fitScaleInitializedRef.current) return;
      if (computeFitScaleFromContainer()) {
        fitScaleInitializedRef.current = true;
      }
    };
    compute();
    const el = scrollContainerRef.current;
    if (!el || fitScaleInitializedRef.current) return;
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeFitScaleFromContainer]);

  // Initial scroll to first evidence page once that target page has a DOM
  // position. Large books should not wait for every prior page to report size:
  // that makes the header say "p.552" while the viewport is still parked on p.1.
  useEffect(() => {
    if (!pdfDoc) return;
    const target = initialScrollPageRef.current;
    if (target == null) return;

    let done = false;
    let rafId: number | null = null;
    const tryScroll = () => {
      if (done) return;
      const container = scrollContainerRef.current;
      const el = pageRefs.current.get(target);
      if (!container || !el || el.offsetHeight === 0) return;
      done = true;
      onPageMeasuredRef.current = null;
      window.requestAnimationFrame(() => {
        container.scrollTop = el.offsetTop;
        setPage(target);
        currentPageRef.current = target;
        currentPageOffsetRef.current = 0;
        currentPageOffsetRatioRef.current = 0;
        initialScrollPageRef.current = null;
        hasRestoredInitialScrollRef.current = true;
        savePdfViewState(viewStateKey, { page: target, scrollTop: container.scrollTop });
      });
    };

    onPageMeasuredRef.current = (pageNum: number) => {
      if (pageNum !== target) return;
      tryScroll();
    };
    // Initial attempt in case some pages were already measured from a
    // previous mount before this effect ran.
    tryScroll();

    let attempts = 0;
    const retryUntilMounted = () => {
      if (done) return;
      tryScroll();
      if (done) return;
      attempts += 1;
      if (attempts < 180) {
        rafId = window.requestAnimationFrame(retryUntilMounted);
      }
    };
    rafId = window.requestAnimationFrame(retryUntilMounted);

    const timeoutId = window.setTimeout(() => {
      if (done) return;
      const el = pageRefs.current.get(target);
      const container = scrollContainerRef.current;
      if (el && container) {
        done = true;
        onPageMeasuredRef.current = null;
        container.scrollTop = el.offsetTop;
        setPage(target);
        currentPageRef.current = target;
        currentPageOffsetRef.current = 0;
        currentPageOffsetRatioRef.current = 0;
        savePdfViewState(viewStateKey, { page: target, scrollTop: container.scrollTop });
        initialScrollPageRef.current = null;
        hasRestoredInitialScrollRef.current = true;
      }
    }, 4_000);

    return () => {
      done = true;
      onPageMeasuredRef.current = null;
      if (rafId != null) window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [pdfDoc, intrinsicPageSize, viewStateKey]);

  const handlePageMeasured = useCallback((pageNum: number) => {
    measuredPagesRef.current.add(pageNum);
    onPageMeasuredRef.current?.(pageNum);
  }, []);

  const captureCurrentAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerTop = container.scrollTop;
    let bestPage = 1;
    let bestOffsetTop = 0;
    let bestHeight = 1;
    let fallbackPage = 1;
    let fallbackDelta = Infinity;
    for (const [pageNum, el] of pageRefs.current.entries()) {
      if (el.offsetTop <= containerTop + 4 && el.offsetTop >= bestOffsetTop) {
        bestPage = pageNum;
        bestOffsetTop = el.offsetTop;
        bestHeight = Math.max(1, el.offsetHeight);
      }
      const delta = Math.abs(el.offsetTop - containerTop);
      if (delta < fallbackDelta) {
        fallbackDelta = delta;
        fallbackPage = pageNum;
      }
    }
    if (bestOffsetTop === 0 && containerTop > 4) {
      const fallbackEl = pageRefs.current.get(fallbackPage);
      bestPage = fallbackPage;
      bestOffsetTop = fallbackEl?.offsetTop ?? 0;
      bestHeight = Math.max(1, fallbackEl?.offsetHeight ?? 1);
    }
    const offset = Math.max(0, containerTop - bestOffsetTop);
    currentPageRef.current = bestPage;
    currentPageOffsetRef.current = offset;
    currentPageOffsetRatioRef.current = Math.max(0, Math.min(1, offset / bestHeight));
  }, []);

  useEffect(() => {
    const refreshEvidence = (event: Event) => {
      const detail = (event as CustomEvent<{ conceptId?: number }>).detail;
      if (detail?.conceptId !== conceptId) return;
      captureCurrentAnchor();
      void window.api.concepts.sourceEvidence(conceptId).then(next => {
        if (next) setData(next);
      });
    };
    window.addEventListener('starcall:equations-changed', refreshEvidence);
    return () => window.removeEventListener('starcall:equations-changed', refreshEvidence);
  }, [captureCurrentAnchor, conceptId]);

  // Track currently visible page based on scroll position.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    captureCurrentAnchor();
    const bestPage = currentPageRef.current;
    setPage(prev => (prev === bestPage ? prev : bestPage));
    if (hasRestoredInitialScrollRef.current) {
      savePdfViewState(viewStateKey, { page: bestPage, scrollTop: container.scrollTop });
    }
  }, [captureCurrentAnchor, viewStateKey]);

  const reanchorCurrentPage = useCallback(() => {
    if (!pdfDoc || initialScrollPageRef.current != null) return;
    if (!hasRestoredInitialScrollRef.current) return;
    const target = currentPageRef.current;
    window.requestAnimationFrame(() => {
      const el = pageRefs.current.get(target);
      if (!el) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      const offset = Math.min(
        Math.max(0, el.offsetHeight - 1),
        currentPageOffsetRatioRef.current * Math.max(1, el.offsetHeight),
      );
      currentPageOffsetRef.current = offset;
      container.scrollTop = el.offsetTop + offset;
      setPage(target);
      if (container) savePdfViewState(viewStateKey, { page: target, scrollTop: container.scrollTop });
    });
  }, [pdfDoc, viewStateKey]);

  // Layout changes (closing side rails, resizing split panes, zoom changes) alter
  // every page's pixel height. Re-anchor by logical page so the header and the
  // visible PDF page cannot drift apart.
  useLayoutEffect(() => {
    if (!pdfDoc || initialScrollPageRef.current != null) return;
    if (!hasRestoredInitialScrollRef.current) return;
    if (scaleBeforeResizeRef.current === renderScale) return;
    scaleBeforeResizeRef.current = renderScale;
    reanchorCurrentPage();
  }, [pdfDoc, renderScale, reanchorCurrentPage]);

  useLayoutEffect(() => {
    reanchorCurrentPage();
  }, [stabilityKey, reanchorCurrentPage]);

  // Electron/Chromium may restore scroll containers after focus/visibility
  // changes. Trust the logical page we tracked, then put the PDF stack back
  // under that label when the window becomes active again.
  useEffect(() => {
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'hidden') return;
      reanchorCurrentPage();
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    return () => {
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    };
  }, [reanchorCurrentPage]);

  const registerPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNum, el);
    else pageRefs.current.delete(pageNum);
  }, []);

  function scrollToPage(targetPage: number): void {
    const el = pageRefs.current.get(targetPage);
    if (el) {
      const container = scrollContainerRef.current;
      if (container) container.scrollTop = el.offsetTop;
      else el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setPage(targetPage);
      currentPageRef.current = targetPage;
      currentPageOffsetRef.current = 0;
      currentPageOffsetRatioRef.current = 0;
      savePdfViewState(viewStateKey, { page: targetPage, scrollTop: container?.scrollTop ?? el.offsetTop });
    }
  }

  function zoomIn():   void { captureCurrentAnchor(); setUserZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))); }
  function zoomOut():  void { captureCurrentAnchor(); setUserZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))); }
  function zoomReset(): void {
    captureCurrentAnchor();
    computeFitScaleFromContainer();
    setUserZoom(1.0);
  }

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
            onClick={() => { captureCurrentAnchor(); setEvidenceRailCollapsed(false); }}
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
                  onClick={() => { captureCurrentAnchor(); setEvidenceRailCollapsed(true); }}
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
          {pdfDoc && intrinsicPageSize != null && Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
            <PdfPage
              key={pageNum}
              doc={pdfDoc}
              pageNum={pageNum}
              scale={renderScale}
              fallbackSize={{
                width: intrinsicPageSize.width * renderScale,
                height: intrinsicPageSize.height * renderScale,
              }}
              registerRef={registerPageRef}
              onMeasured={handlePageMeasured}
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
  doc, pageNum, scale, fallbackSize, registerRef, onMeasured, scrollContainerRef,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  fallbackSize: { width: number; height: number };
  registerRef: (pageNum: number, el: HTMLDivElement | null) => void;
  onMeasured?: (pageNum: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const boxSize = size ?? fallbackSize;

  // Recompute reserved size whenever scale changes.
  useEffect(() => {
    let cancelled = false;
    setSize(null);
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

  // Fire onMeasured AFTER the DOM commit so the parent can read a non-zero
  // offsetHeight on the wrapper. useLayoutEffect runs synchronously after
  // size state is applied — using a plain useEffect (or calling from
  // inside the async block above) would race ahead of the browser's layout.
  useLayoutEffect(() => {
    if (size && onMeasured) onMeasured(pageNum);
  }, [size, onMeasured, pageNum]);

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
  }, [scrollContainerRef, boxSize.width, boxSize.height]);

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
        width: boxSize.width,
        height: boxSize.height,
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

function readSavedPdfViewState(key: string): SavedPdfViewState | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedPdfViewState>;
    if (!Number.isFinite(parsed.page) || !Number.isFinite(parsed.scrollTop)) return null;
    return { page: Number(parsed.page), scrollTop: Math.max(0, Number(parsed.scrollTop)) };
  } catch {
    return null;
  }
}

function savePdfViewState(key: string, state: SavedPdfViewState): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({
      page: Math.max(1, Math.floor(state.page)),
      scrollTop: Math.max(0, Math.floor(state.scrollTop)),
    }));
  } catch {
    // Session storage is best-effort; source navigation should still work.
  }
}

function clampPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(Math.floor(page), Math.max(1, totalPages)));
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
