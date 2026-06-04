import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { PdfAnnotation, PdfAnnotationRect } from '@starcall/shared';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vite ?url import returns a string path the worker loader uses
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl as unknown as string;

interface Evidence {
  index: number;
  page: number;
  kind: string;
  label: string;
  quote?: string;
}

const EVIDENCE_KINDS = ['chunk', 'definition', 'heading', 'equation', 'relation'] as const;

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
const SHOW_SOURCE_ANNOTATIONS_KEY = 'starcall.pdfAnnotations.showSourceWide';
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 3.0;
const ZOOM_STEP = 0.1;
const GLASS_PANEL_BG = 'rgba(4, 6, 26, 0.34)';
const GLASS_BORDER = '1px solid rgba(31, 41, 55, 0.72)';
const GLASS_BLUR = 'blur(14px)';
const CONCEPT_ANNOTATION_COLORS = [
  '#facc15',
  '#38bdf8',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#f97316',
  '#22d3ee',
  '#c084fc',
];

// Highlight swatches — light-to-mid darkness (readable as a highlighter over
// text), cycled deterministically rather than randomized.
const HIGHLIGHT_PALETTE = [
  '#fcd34d', // amber
  '#f87171', // red
  '#6ee7b7', // green
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#f472b6', // pink
  '#2dd4bf', // teal
  '#fb923c', // orange
];

interface SavedPdfViewState {
  page: number;
  scrollTop: number;
}

interface HighlightAction {
  page: number;
  selectedText: string;
  rects: PdfAnnotationRect[];
  anchor: { x: number; y: number };
  pageSize: { width: number; height: number };
  rotation: number;
}

interface AnnotationEditor {
  annotation: PdfAnnotation;
  anchor: { x: number; y: number };
}

interface Props {
  conceptId: number;
  conceptName: string;
  stabilityKey?: string;
  onResizeMouseDown?: (e: React.MouseEvent<HTMLElement>) => void;
  // External request to scroll to a page (e.g. a note linked to a highlight).
  // The nonce lets repeated jumps to the same page re-fire.
  jumpTarget?: { page: number; nonce: number } | null;
}

function normalizeSelectedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function conceptAnnotationColor(conceptId: number): string {
  const index = Math.abs(conceptId) % CONCEPT_ANNOTATION_COLORS.length;
  return CONCEPT_ANNOTATION_COLORS[index];
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function clippedSelectionRange(selectionRange: Range, span: HTMLElement): Range | null {
  const spanRange = document.createRange();
  spanRange.selectNodeContents(span);
  if (!rangeIntersectsNode(selectionRange, span)) {
    spanRange.detach?.();
    return null;
  }

  const clipped = document.createRange();
  if (selectionRange.compareBoundaryPoints(Range.START_TO_START, spanRange) <= 0) {
    clipped.setStart(spanRange.startContainer, spanRange.startOffset);
  } else {
    clipped.setStart(selectionRange.startContainer, selectionRange.startOffset);
  }
  if (selectionRange.compareBoundaryPoints(Range.END_TO_END, spanRange) >= 0) {
    clipped.setEnd(spanRange.endContainer, spanRange.endOffset);
  } else {
    clipped.setEnd(selectionRange.endContainer, selectionRange.endOffset);
  }
  spanRange.detach?.();

  if (clipped.collapsed || normalizeSelectedText(clipped.toString()).length === 0) {
    clipped.detach?.();
    return null;
  }
  return clipped;
}

function mergeClientRects(rects: DOMRect[]): DOMRect[] {
  const sorted = [...rects]
    .filter(r => r.width > 0 && r.height > 0)
    .sort((a, b) => Math.abs(a.top - b.top) > 3 ? a.top - b.top : a.left - b.left);
  const merged: DOMRect[] = [];
  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    const rectMid = rect.top + rect.height / 2;
    const lastMid = last ? last.top + last.height / 2 : 0;
    const sameLine = last && Math.abs(rectMid - lastMid) <= Math.max(3, Math.min(8, rect.height * 0.45));
    const closeEnough = last && rect.left - last.right <= Math.max(10, rect.height * 0.8);
    if (sameLine && closeEnough) {
      const left = Math.min(last.left, rect.left);
      const top = Math.min(last.top, rect.top);
      const right = Math.max(last.right, rect.right);
      const bottom = Math.max(last.bottom, rect.bottom);
      merged[merged.length - 1] = DOMRect.fromRect({ x: left, y: top, width: right - left, height: bottom - top });
    } else {
      merged.push(rect);
    }
  }
  return merged;
}

function normalizedSelectionRectsForPage(pageEl: HTMLElement, selectionRange: Range): { rects: PdfAnnotationRect[]; firstRect: DOMRect | null } {
  const textLayer = pageEl.querySelector<HTMLElement>('.pdf-text-layer');
  if (!textLayer || !rangeIntersectsNode(selectionRange, textLayer)) {
    return { rects: [], firstRect: null };
  }

  const pageRect = pageEl.getBoundingClientRect();
  const rawRects: DOMRect[] = [];
  for (const span of Array.from(textLayer.querySelectorAll<HTMLElement>('span'))) {
    const clipped = clippedSelectionRange(selectionRange, span);
    if (!clipped) continue;
    rawRects.push(
      ...Array.from(clipped.getClientRects())
        .filter(r => r.width > 0 && r.height > 0),
    );
    clipped.detach?.();
  }

  const mergedRects = mergeClientRects(rawRects);
  const rects = mergedRects
    .map(rect => {
      const left = Math.max(rect.left, pageRect.left);
      const top = Math.max(rect.top, pageRect.top);
      const right = Math.min(rect.right, pageRect.right);
      const bottom = Math.min(rect.bottom, pageRect.bottom);
      if (right <= left || bottom <= top) return null;
      return {
        x: (left - pageRect.left) / pageRect.width,
        y: (top - pageRect.top) / pageRect.height,
        width: (right - left) / pageRect.width,
        height: (bottom - top) / pageRect.height,
      };
    })
    .filter((r): r is PdfAnnotationRect => r != null);

  return { rects, firstRect: mergedRects[0] ?? rawRects[0] ?? null };
}

function notePositionFromClientPoint(
  clientX: number,
  clientY: number,
  pageRect: DOMRect,
  containerRect: DOMRect,
): { x: number; y: number } {
  const markerSize = 18;
  const safeX = Math.max(containerRect.left, Math.min(containerRect.right - markerSize, clientX));
  const safeY = Math.max(containerRect.top, Math.min(containerRect.bottom - markerSize, clientY));
  return {
    x: (safeX - pageRect.left) / pageRect.width,
    y: (safeY - pageRect.top) / pageRect.height,
  };
}

export default function PdfViewer({ conceptId, conceptName, stabilityKey, onResizeMouseDown, jumpTarget }: Props) {
  const [data, setData] = useState<SourceEvidence | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // Default OFF so the full PDF renders; toggling on scopes to evidence pages
  // (sparse concepts like a single-heading entry would otherwise show just one
  // page and feel like the scrollwheel is broken).
  const [evidenceOnly, setEvidenceOnly] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [pendingDeletedAnnotations, setPendingDeletedAnnotations] = useState<PdfAnnotation[]>([]);
  const [highlightAction, setHighlightAction] = useState<HighlightAction | null>(null);
  const [annotationEditor, setAnnotationEditor] = useState<AnnotationEditor | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [evidenceRailCollapsed, setEvidenceRailCollapsed] = useState(() => localStorage.getItem(EVIDENCE_RAIL_KEY) === 'true');
  // Evidence editor: -2 = adding a new span, >=0 = editing that storage index.
  const [evEditingIndex, setEvEditingIndex] = useState<number | null>(null);
  const [evDraft, setEvDraft] = useState<{ page: string; kind: string; label: string; quote: string } | null>(null);
  const [showSourceAnnotations, setShowSourceAnnotations] = useState(() => localStorage.getItem(SHOW_SOURCE_ANNOTATIONS_KEY) === 'true');
  const [userZoom, setUserZoom] = useState<number>(() => {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(stored) && stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : 1.0;
  });
  const [fitScale, setFitScale] = useState<number>(1.0);
  const [intrinsicPageSize, setIntrinsicPageSize] = useState<{ width: number; height: number } | null>(null);
  const renderScale = fitScale * userZoom;

  // Source search. PDF results are matching pages; text results are match
  // offsets into textBody. null = no active search.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ page: number; snippet: string; offset?: number }> | null>(null);
  const [searching, setSearching] = useState(false);
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const textMatchRefs = useRef<Map<number, HTMLElement>>(new Map());

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
  const pendingDeleteTimersRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    localStorage.setItem(EVIDENCE_RAIL_KEY, String(evidenceRailCollapsed));
  }, [evidenceRailCollapsed]);

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(userZoom));
  }, [userZoom]);

  useEffect(() => {
    localStorage.setItem(SHOW_SOURCE_ANNOTATIONS_KEY, String(showSourceAnnotations));
  }, [showSourceAnnotations]);

  useEffect(() => () => {
    for (const timerId of pendingDeleteTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    pendingDeleteTimersRef.current.clear();
  }, []);

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
    setAnnotations([]);
    setPendingDeletedAnnotations([]);
    setHighlightAction(null);
    setAnnotationEditor(null);
    setNoteMode(false);
    setIntrinsicPageSize(null);
    setSearchQuery('');
    setSearchResults(null);
    pageTextCacheRef.current.clear();
    textMatchRefs.current.clear();
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

  useEffect(() => {
    if (!data?.isPdf) return;
    let cancelled = false;
    window.api.sources.annotations.list(data.sourceId).then(rows => {
      if (!cancelled) setAnnotations(rows);
    }).catch(e => {
      console.error('[PdfViewer] annotation load failed', e);
    });
    return () => { cancelled = true; };
  }, [data?.isPdf, data?.sourceId]);

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
    // Work in viewport space: `offsetTop` is relative to the nearest positioned
    // ancestor (NOT the scroll container), so comparing it against scrollTop
    // mixes coordinate systems and reports the wrong page (off by one). Use
    // getBoundingClientRect deltas instead — the same basis as scrollToPage and
    // the selection-geometry that stamps highlight pages, so the header label
    // and stored annotation pages agree.
    const containerTop = container.getBoundingClientRect().top;
    let bestPage = 1;
    let bestTop = -Infinity; // page top relative to container top; topmost started page
    let bestHeight = 1;
    let bestFound = false;
    let fallbackPage = 1;
    let fallbackDelta = Infinity;
    for (const [pageNum, el] of pageRefs.current.entries()) {
      const rect = el.getBoundingClientRect();
      const top = rect.top - containerTop; // 0 = page top aligned to container top
      if (top <= 4 && top >= bestTop) {
        bestPage = pageNum;
        bestTop = top;
        bestHeight = Math.max(1, rect.height);
        bestFound = true;
      }
      const delta = Math.abs(top);
      if (delta < fallbackDelta) {
        fallbackDelta = delta;
        fallbackPage = pageNum;
      }
    }
    if (!bestFound) {
      const fallbackEl = pageRefs.current.get(fallbackPage);
      const rect = fallbackEl?.getBoundingClientRect();
      bestPage = fallbackPage;
      bestTop = rect ? rect.top - containerTop : 0;
      bestHeight = Math.max(1, rect?.height ?? 1);
    }
    const offset = Math.max(0, -bestTop); // how far the current page is scrolled past the top
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
      // Align by rect delta (same as scrollToPage). `offsetTop` is relative to
      // the nearest positioned ancestor, which is NOT the scroll container, so
      // using it here re-scrolls a full page early and undoes a correct jump.
      const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += delta + offset;
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
      if (container) {
        // Align the target page's top to the container top using a rect delta —
        // robust to wrapper nesting (offsetTop is relative to offsetParent, which
        // isn't always the scroll container and can land a page early).
        const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += delta;
      } else {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      setPage(targetPage);
      currentPageRef.current = targetPage;
      currentPageOffsetRef.current = 0;
      currentPageOffsetRatioRef.current = 0;
      savePdfViewState(viewStateKey, { page: targetPage, scrollTop: container?.scrollTop ?? el.offsetTop });
    }
  }

  // Defensive wheel handler: native overflow:auto sometimes fails to scroll
  // when a child (text-layer, canvas, annotation overlay) eats the wheel. Use
  // a non-passive listener so we can preventDefault and drive the scroll
  // ourselves — guarantees the mousewheel works on the PDF area.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      el.scrollTop += e.deltaY;
      el.scrollLeft += e.deltaX;
      e.preventDefault();
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pdfDoc]);

  // External jump request (e.g. clicking a note's linked highlight). Retries
  // across animation frames until the target page wrapper is mounted, then
  // aligns it to the top using the same rect-delta math as scrollToPage.
  const jumpNonce = jumpTarget?.nonce;
  useEffect(() => {
    if (!pdfDoc || !jumpTarget) return;
    const target = clampPage(jumpTarget.page, pdfDoc.numPages);
    let done = false;
    let attempts = 0;
    const tryJump = () => {
      if (done) return;
      const el = pageRefs.current.get(target);
      const container = scrollContainerRef.current;
      if (el && container) {
        const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += delta;
        setPage(target);
        currentPageRef.current = target;
        currentPageOffsetRef.current = 0;
        currentPageOffsetRatioRef.current = 0;
        done = true;
        return;
      }
      attempts += 1;
      if (attempts < 180) window.requestAnimationFrame(tryJump);
    };
    window.requestAnimationFrame(tryJump);
    return () => { done = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce, pdfDoc]);

  function clearSearch(): void {
    setSearchQuery('');
    setSearchResults(null);
  }

  function snippetAround(text: string, idx: number, qLen: number): string {
    const start = Math.max(0, idx - 32);
    const end = Math.min(text.length, idx + qLen + 48);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  }

  async function runSearch(): Promise<void> {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); return; }
    const ql = q.toLowerCase();
    setSearching(true);
    try {
      if (data?.isPdf && pdfDoc) {
        const results: Array<{ page: number; snippet: string }> = [];
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          let text = pageTextCacheRef.current.get(p);
          if (text == null) {
            const pg = await pdfDoc.getPage(p);
            const tc = await pg.getTextContent();
            text = tc.items.map(it => ('str' in it ? (it as { str: string }).str : '')).join(' ');
            pageTextCacheRef.current.set(p, text);
          }
          const idx = text.toLowerCase().indexOf(ql);
          if (idx >= 0) results.push({ page: p, snippet: snippetAround(text, idx, q.length) });
        }
        setSearchResults(results);
      } else if (textBody != null) {
        // Text source: collect match offsets so the results list can scroll to
        // each highlighted hit in the rendered body.
        const lower = textBody.toLowerCase();
        const results: Array<{ page: number; snippet: string; offset: number }> = [];
        let from = 0;
        let matchIdx = 0;
        while (results.length < 500) {
          const idx = lower.indexOf(ql, from);
          if (idx < 0) break;
          results.push({ page: 1, offset: matchIdx, snippet: snippetAround(textBody, idx, q.length) });
          from = idx + ql.length;
          matchIdx += 1;
        }
        setSearchResults(results);
      }
    } finally {
      setSearching(false);
    }
  }

  function scrollToTextMatch(matchIndex: number): void {
    const el = textMatchRefs.current.get(matchIndex);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function renderSearchBar(): React.ReactNode {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void runSearch(); if (e.key === 'Escape') clearSearch(); }}
          placeholder="Search source…"
          style={{
            width: 150, height: 28, boxSizing: 'border-box',
            background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            border: '1px solid #263244', borderRadius: 4, padding: '0 8px',
            color: '#e2e8f0', fontSize: 11, outline: 'none',
          }}
        />
        <button onClick={() => void runSearch()} title="Search" disabled={searching} style={navBtnStyle}>
          {searching ? '…' : '⌕'}
        </button>
        {searchResults != null && (
          <button onClick={clearSearch} title="Clear search" style={navBtnStyle}>×</button>
        )}
      </div>
    );
  }

  function renderSearchPanel(): React.ReactNode {
    if (searchResults == null) return null;
    const isPdf = !!data?.isPdf;
    return (
      <div style={{
        borderBottom: '1px solid rgba(31,41,55,0.75)',
        background: 'rgba(4,6,26,0.5)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        maxHeight: 220, overflowY: 'auto',
      }}>
        <div style={{ padding: '6px 12px', fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {searchResults.length === 0
            ? 'No matches'
            : isPdf
              ? `${searchResults.length} page${searchResults.length === 1 ? '' : 's'} match`
              : `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'}`}
        </div>
        {searchResults.map((r, i) => (
          <button
            key={isPdf ? `p${r.page}` : `m${r.offset}`}
            className="rel-opt"
            onClick={() => { if (isPdf) scrollToPage(r.page); else scrollToTextMatch(r.offset ?? i); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
              border: 'none', borderTop: '1px solid rgba(31,41,55,0.4)', cursor: 'pointer',
              padding: '7px 12px', color: '#cbd5e1', fontSize: 12,
            }}
          >
            {isPdf && <span style={{ color: '#818cf8', fontWeight: 700, marginRight: 8 }}>p.{r.page}</span>}
            <span style={{ color: '#94a3b8' }}>{r.snippet}</span>
          </button>
        ))}
      </div>
    );
  }

  // Render the plain-text body, wrapping search matches in <mark> nodes whose
  // refs let the results list scroll to each hit.
  function renderTextBody(): React.ReactNode {
    const body = textBody ?? '(empty)';
    const q = searchQuery.trim();
    if (searchResults == null || !q) return body;
    textMatchRefs.current.clear();
    const ql = q.toLowerCase();
    const lower = body.toLowerCase();
    const out: React.ReactNode[] = [];
    let from = 0;
    let matchIdx = 0;
    let idx = lower.indexOf(ql, from);
    while (idx >= 0) {
      if (idx > from) out.push(body.slice(from, idx));
      const capture = matchIdx;
      out.push(
        <mark
          key={`m${capture}`}
          ref={(el: HTMLElement | null) => { if (el) textMatchRefs.current.set(capture, el); else textMatchRefs.current.delete(capture); }}
          style={{ background: 'rgba(250,204,21,0.4)', color: '#fde68a', borderRadius: 2 }}
        >
          {body.slice(idx, idx + q.length)}
        </mark>,
      );
      from = idx + ql.length;
      matchIdx += 1;
      idx = lower.indexOf(ql, from);
    }
    if (from < body.length) out.push(body.slice(from));
    return out;
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
        <Header data={data} conceptName={conceptName} extras={renderSearchBar()} />
        {renderSearchPanel()}
        {/* Readable article column rather than a monospace wall: proportional
            font, comfortable measure, generous line-height. pre-wrap preserves
            the paragraph breaks from the extracted text; renderTextBody keeps
            search-match <mark>s working. */}
        <div className="concept-scroll" style={{ flex: 1, overflow: 'auto', background: '#0d0d16' }}>
          <div style={{
            maxWidth: 720, margin: '0 auto', padding: '28px 32px',
            color: '#d8dee9', fontSize: 14.5, lineHeight: 1.75,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'Georgia, Cambria, "Times New Roman", serif',
          }}>
            {renderTextBody()}
          </div>
        </div>
      </div>
    );
  }

  const totalPages = pdfDoc?.numPages ?? data.pageCount ?? 1;
  const visibleEvidenceList = evidenceOnly && evidencePages.length > 0
    ? data.evidence.filter(e => evidencePages.includes(e.page))
    : data.evidence;
  const visibleAnnotations = annotations.filter(annotation => {
    if (annotation.scope === 'concept') {
      return annotation.concept_id === conceptId;
    }
    return showSourceAnnotations;
  });
  const annotationsByPage = new Map<number, PdfAnnotation[]>();
  for (const annotation of visibleAnnotations) {
    const list = annotationsByPage.get(annotation.page) ?? [];
    list.push(annotation);
    annotationsByPage.set(annotation.page, list);
  }

  async function deleteEvidence(index: number): Promise<void> {
    // Capture the span before deletion so we can find its backing highlight.
    const span = data?.evidence.find(e => e.index === index);
    try {
      const updated = await window.api.concepts.deleteEvidence({ conceptId, index });
      if (updated) setData(updated as SourceEvidence);
      // Highlight-backed evidence: also remove the highlight and clear any note
      // that linked to it (so the note's chip in Overview goes away too).
      if (span?.kind === 'highlight') {
        const evq = normalizeSelectedText(span.quote ?? '');
        const hl = annotations.find(a => {
          if (a.type !== 'highlight' || a.page !== span.page) return false;
          const at = normalizeSelectedText(a.selected_text);
          return !!at && (at === evq || at.includes(evq) || evq.includes(at));
        });
        if (hl) {
          await window.api.sources.annotations.delete(hl.id);
          setAnnotations(prev => prev.filter(a => a.id !== hl.id));
          try {
            const notes = await window.api.concepts.notes.list(conceptId);
            await Promise.all(
              (notes as Array<{ id: number; linked_annotation_id: number | null }>)
                .filter(n => n.linked_annotation_id === hl.id)
                .map(n => window.api.concepts.notes.update({ id: n.id, linkedAnnotationId: null })),
            );
          } catch (e) { console.error('[PdfViewer] clearing note link failed', e); }
          window.dispatchEvent(new Event('starcall:evidenceChanged'));
          window.dispatchEvent(new Event('starcall:notesChanged'));
        }
      }
    } catch (e) {
      console.error('[PdfViewer] deleteEvidence failed', e);
    }
  }
  async function saveEvidenceDraft(): Promise<void> {
    if (!evDraft) return;
    const payload = { page: Number(evDraft.page) || 1, kind: evDraft.kind, label: evDraft.label.trim() || evDraft.kind, quote: evDraft.quote.trim() || undefined };
    try {
      const updated = evEditingIndex === -2
        ? await window.api.concepts.addEvidence({ conceptId, ...payload })
        : await window.api.concepts.updateEvidence({ conceptId, index: evEditingIndex, ...payload });
      if (updated) setData(updated as SourceEvidence);
    } catch (e) {
      console.error('[PdfViewer] saveEvidenceDraft failed', e);
    } finally {
      setEvEditingIndex(null);
      setEvDraft(null);
    }
  }
  function openEvidenceEditor(e: Evidence): void {
    setEvEditingIndex(e.index);
    setEvDraft({ page: String(e.page), kind: EVIDENCE_KINDS.includes(e.kind as typeof EVIDENCE_KINDS[number]) ? e.kind : 'chunk', label: e.label, quote: e.quote ?? '' });
  }
  function openEvidenceAdd(): void {
    setEvEditingIndex(-2);
    setEvDraft({ page: String(page || 1), kind: 'chunk', label: '', quote: '' });
  }
  function cancelEvidenceEdit(): void { setEvEditingIndex(null); setEvDraft(null); }
  function renderEvidenceEditor(): React.ReactNode {
    if (!evDraft) return null;
    const inp: React.CSSProperties = { background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', border: '1px solid #263244', borderRadius: 4, padding: '5px 7px', color: '#e2e8f0', fontSize: 11, outline: 'none', boxSizing: 'border-box' };
    return (
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(17,24,39,0.72)', background: 'rgba(13,13,22,0.5)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={evDraft.page} onChange={e => setEvDraft(d => d ? { ...d, page: e.target.value } : d)} placeholder="pg" inputMode="numeric" style={{ ...inp, width: 46, flexShrink: 0 }} />
          <select value={evDraft.kind} onChange={e => setEvDraft(d => d ? { ...d, kind: e.target.value } : d)} style={{ ...inp, flexShrink: 0, cursor: 'pointer' }}>
            {EVIDENCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <input value={evDraft.label} onChange={e => setEvDraft(d => d ? { ...d, label: e.target.value } : d)} placeholder="label" style={{ ...inp, flex: 1, minWidth: 0 }} />
        </div>
        <textarea value={evDraft.quote} onChange={e => setEvDraft(d => d ? { ...d, quote: e.target.value } : d)} placeholder="quote (optional)" rows={2} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }} />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => void saveEvidenceDraft()} style={{ background: '#312e81', border: '1px solid #6366f1', borderRadius: 4, padding: '4px 12px', color: '#e0e7ff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Save</button>
          <button onClick={cancelEvidenceEdit} title="Cancel" aria-label="Cancel" style={{ width: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>
      </div>
    );
  }

  function handleSelectionMouseUp(e: React.MouseEvent<HTMLDivElement>): void {
    if (noteMode) return;
    if ((e.target as HTMLElement | null)?.closest('[data-pdf-annotation-control="true"]')) return;
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setHighlightAction(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const pageHits = new Map<number, { pageRect: DOMRect; rects: PdfAnnotationRect[]; firstRect: DOMRect }>();
      for (const [pageNum, pageEl] of pageRefs.current.entries()) {
        const { rects, firstRect } = normalizedSelectionRectsForPage(pageEl, range);
        if (!rects.length || !firstRect) continue;
        pageHits.set(pageNum, {
          pageRect: pageEl.getBoundingClientRect(),
          rects,
          firstRect,
        });
      }
      const first = [...pageHits.entries()].sort((a, b) => a[0] - b[0])[0];
      if (!first) {
        setHighlightAction(null);
        return;
      }
      const [targetPage, hit] = first;
      const selectedText = normalizeSelectedText(selection.toString());
      if (!selectedText) {
        setHighlightAction(null);
        return;
      }
      setHighlightAction({
        page: targetPage,
        selectedText,
        rects: hit.rects,
        anchor: { x: hit.firstRect.left, y: hit.firstRect.top - 36 },
        pageSize: { width: hit.pageRect.width, height: hit.pageRect.height },
        rotation: 0,
      });
    }, 0);
  }

  async function createHighlight(): Promise<void> {
    if (!data || !highlightAction) return;
    const created = await window.api.sources.annotations.create({
      sourceId: data.sourceId,
      conceptId,
      scope: 'concept',
      type: 'highlight',
      createdFrom: 'manual_selection',
      page: highlightAction.page,
      color: HIGHLIGHT_PALETTE[annotations.filter(a => a.type === 'highlight').length % HIGHLIGHT_PALETTE.length],
      selectedText: highlightAction.selectedText,
      label: '',
      noteBody: '',
      rects: highlightAction.rects,
      pageWidth: highlightAction.pageSize.width,
      pageHeight: highlightAction.pageSize.height,
      rotation: highlightAction.rotation,
    });
    setAnnotations(prev => [...prev, created]);
    // Each highlight also becomes a concept evidence span so it shows in the
    // Evidence rail (and can back tasks/grading), not just as a page overlay.
    try {
      const updatedEvidence = await window.api.concepts.addEvidence({
        conceptId,
        page: highlightAction.page,
        kind: 'highlight',
        label: 'Highlight',
        quote: highlightAction.selectedText,
        annotationId: created.id,
      });
      if (updatedEvidence) setData(updatedEvidence as SourceEvidence);
      window.dispatchEvent(new Event('starcall:evidenceChanged'));
    } catch (e) {
      console.error('[PdfViewer] highlight→evidence failed', e);
    }
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }

  async function createNote(pageNum: number, rect: PdfAnnotationRect, pageSize: { width: number; height: number }): Promise<void> {
    if (!data) return;
    const created = await window.api.sources.annotations.create({
      sourceId: data.sourceId,
      conceptId,
      scope: 'concept',
      type: 'note',
      createdFrom: 'manual_note',
      page: pageNum,
      color: conceptAnnotationColor(conceptId),
      noteBody: '',
      rects: [rect],
      pageWidth: pageSize.width,
      pageHeight: pageSize.height,
      rotation: 0,
    });
    setAnnotations(prev => [...prev, created]);
    const pageEl = pageRefs.current.get(pageNum);
    const pageRect = pageEl?.getBoundingClientRect();
    setAnnotationEditor({
      annotation: created,
      anchor: pageRect
        ? { x: pageRect.left + rect.x * pageRect.width + 18, y: pageRect.top + rect.y * pageRect.height }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    });
    setNoteMode(false);
  }

  async function saveAnnotation(id: number, patch: { label?: string; noteBody?: string; color?: string; rects?: PdfAnnotationRect[]; pageWidth?: number | null; pageHeight?: number | null; rotation?: number | null }): Promise<void> {
    const updated = await window.api.sources.annotations.update({ id, ...patch });
    if (!updated) return;
    setAnnotations(prev => prev.map(a => a.id === id ? updated : a));
    // Saving from the popover closes (minimizes) it.
    setAnnotationEditor(null);
  }

  async function moveAnnotation(id: number, rects: PdfAnnotationRect[], pageSize: { width: number; height: number }): Promise<void> {
    const updated = await window.api.sources.annotations.update({
      id,
      rects,
      pageWidth: pageSize.width,
      pageHeight: pageSize.height,
      rotation: 0,
    });
    if (!updated) return;
    setAnnotations(prev => prev.map(a => a.id === id ? updated : a));
    setAnnotationEditor(prev => prev?.annotation.id === id ? { ...prev, annotation: updated } : prev);
  }

  async function deleteAnnotation(annotation: PdfAnnotation): Promise<void> {
    const deleted = await window.api.sources.annotations.delete(annotation.id);
    if (!deleted) return;
    setAnnotations(prev => prev.filter(a => a.id !== annotation.id));
    setPendingDeletedAnnotations(prev => [...prev.filter(a => a.id !== annotation.id), deleted]);
    setAnnotationEditor(null);
    const timerId = window.setTimeout(() => {
      pendingDeleteTimersRef.current.delete(annotation.id);
      setPendingDeletedAnnotations(prev => prev.filter(a => a.id !== annotation.id));
      // Evidence span deletion deferred until undo window expires — restoreAnnotation
      // re-creates it on undo, so we must not remove it before the window closes.
      if (annotation.type === 'highlight') {
        void window.api.concepts.deleteEvidenceSpan({
          conceptId, page: annotation.page, kind: 'highlight', quote: annotation.selected_text,
        }).then(updated => {
          if (updated) setData(updated as SourceEvidence);
          window.dispatchEvent(new Event('starcall:evidenceChanged'));
        }).catch(e => console.error('[PdfViewer] highlight evidence cleanup failed', e));
      }
    }, 5_000);
    pendingDeleteTimersRef.current.set(annotation.id, timerId);
  }

  async function restoreAnnotation(annotation: PdfAnnotation): Promise<void> {
    const timerId = pendingDeleteTimersRef.current.get(annotation.id);
    if (timerId != null) {
      window.clearTimeout(timerId);
      pendingDeleteTimersRef.current.delete(annotation.id);
    }
    const restored = await window.api.sources.annotations.restore(annotation.id);
    if (!restored) return;
    setPendingDeletedAnnotations(prev => prev.filter(a => a.id !== annotation.id));
    setAnnotations(prev => [...prev.filter(a => a.id !== annotation.id), restored]);
    // Re-create the evidence span the highlight had contributed.
    if (annotation.type === 'highlight') {
      try {
        const updated = await window.api.concepts.addEvidence({
          conceptId, page: annotation.page, kind: 'highlight', label: 'Highlight', quote: annotation.selected_text,
        });
        if (updated) setData(updated as SourceEvidence);
        window.dispatchEvent(new Event('starcall:evidenceChanged'));
      } catch (e) { console.error('[PdfViewer] highlight evidence restore failed', e); }
    }
  }
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Side rail of evidence chips */}
      <aside style={{
        width: evidenceRailCollapsed ? 36 : 260,
        borderRight: GLASS_BORDER,
        background: GLASS_PANEL_BG,
        backdropFilter: GLASS_BLUR,
        display: 'flex', flexDirection: 'column', overflow: 'hidden', alignItems: evidenceRailCollapsed ? 'center' : 'stretch',
        flexShrink: 0,
        position: 'relative',
      }}>
        {onResizeMouseDown && (
          <div
            onMouseDown={onResizeMouseDown}
            title="Drag to resize content and source"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: 10,
              zIndex: 6,
              cursor: 'col-resize',
              background: 'transparent',
            }}
          />
        )}
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
            <div style={{ padding: '10px 14px', borderBottom: GLASS_BORDER, background: GLASS_PANEL_BG }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Evidence ({data.evidence.length})
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={openEvidenceAdd}
                    title="Add evidence"
                    aria-label="Add evidence"
                    style={{ background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 4, padding: '2px 8px', color: '#c7d2fe', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                  >
                    +
                  </button>
                  <button
                    onClick={() => { captureCurrentAnchor(); setEvidenceRailCollapsed(true); }}
                    title="Minimize evidence rail"
                    style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '2px 7px', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                  >
                    ‹
                  </button>
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: evidenceOnly ? '#c7d2fe' : '#9ca3af', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox" checked={evidenceOnly}
                  onChange={e => setEvidenceOnly(e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                />
                <span aria-hidden="true" style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 13, height: 13, borderRadius: 3,
                  background: evidenceOnly ? 'rgba(129,140,248,0.28)' : 'transparent',
                  border: `1px solid ${evidenceOnly ? '#6366f1' : '#374151'}`,
                  color: '#c7d2fe', fontSize: 10, lineHeight: 1, flexShrink: 0,
                  transition: 'background-color 110ms ease, border-color 110ms ease',
                }}>{evidenceOnly ? '✓' : ''}</span>
                ({evidencePages.length}) related pages only
              </label>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {evEditingIndex === -2 && renderEvidenceEditor()}
              {visibleEvidenceList.map((e, i) => {
                // Highlight evidence mirrors its on-page highlight color. Match
                // by annotation id (stable across description edits/recolor);
                // fall back to quote match for legacy spans without an id.
                const color = e.kind === 'highlight'
                  ? ((e.annotationId != null
                      ? annotations.find(a => a.id === e.annotationId)
                      : annotations.find(a =>
                          a.type === 'highlight' &&
                          a.page === e.page &&
                          normalizeSelectedText(a.selected_text) === normalizeSelectedText(e.quote ?? ''),
                        ))?.color ?? KIND_COLOR.chunk)
                  : (KIND_COLOR[e.kind] ?? '#6b7280');
                const selected = e.page === page;
                if (evEditingIndex === e.index && e.index >= 0) {
                  return <div key={`edit-${e.index}`}>{renderEvidenceEditor()}</div>;
                }
                const editable = e.index >= 0;
                return (
                  <div key={i} className="ev-row" style={{
                    display: 'flex', alignItems: 'stretch',
                    background: selected ? 'rgba(129, 140, 248, 0.12)' : 'transparent',
                    borderLeft: `3px solid ${selected ? color : 'transparent'}`,
                    borderBottom: '1px solid rgba(17,24,39,0.72)',
                  }}>
                    <button
                      onClick={() => scrollToPage(e.page)}
                      style={{
                        flex: 1, textAlign: 'left', minWidth: 0,
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
                    {editable && (
                      <button
                        className="ev-action ev-del"
                        onClick={() => void deleteEvidence(e.index)}
                        title="Remove this evidence"
                        aria-label="Remove this evidence"
                        style={{
                          flexShrink: 0, background: 'transparent', border: 'none', color: '#f87171',
                          padding: '0 9px', fontSize: 15, lineHeight: 1, cursor: 'pointer',
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {visibleEvidenceList.length === 0 && evEditingIndex !== -2 && (
                <div style={{ padding: 20, color: '#374151', fontSize: 11, textAlign: 'center' }}>
                  No evidence yet. Add a highlight or evidence span to populate this list.
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
            <button
              onClick={() => { setNoteMode(v => !v); setHighlightAction(null); }}
              title="Add sticky note"
              data-pdf-annotation-control="true"
              style={noteMode ? activeAnnotBtnStyle : navBtnStyle}
            >
              + Note
            </button>
            <label
              title="Show source-wide highlights and notes from this PDF"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 28,
                padding: '0 10px',
                borderRadius: 4,
                border: showSourceAnnotations ? '1px solid #6366f1' : '1px solid #1f2937',
                background: showSourceAnnotations ? 'rgba(49, 46, 129, 0.52)' : 'rgba(4, 6, 26, 0.28)',
                color: showSourceAnnotations ? '#e0e7ff' : '#64748b',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: showSourceAnnotations ? '#818cf8' : 'transparent',
                border: showSourceAnnotations ? '1px solid #c7d2fe' : '1px solid #334155',
                boxShadow: showSourceAnnotations ? '0 0 10px rgba(129, 140, 248, 0.55)' : 'none',
              }} />
              <input
                type="checkbox"
                checked={showSourceAnnotations}
                onChange={e => setShowSourceAnnotations(e.target.checked)}
                data-pdf-annotation-control="true"
                style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
              />
              Source-wide
            </label>
            <span style={{ width: 8 }} />
            <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 100, textAlign: 'center' }}>
              Page {page} / {totalPages}
            </span>
            <span style={{ width: 8 }} />
            {renderSearchBar()}
          </>
        } />
        {renderSearchPanel()}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onMouseUp={handleSelectionMouseUp}
          style={{
            flex: 1, overflow: 'auto', background: 'transparent',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: 0, gap: 8,
          }}
        >
          {pdfDoc && intrinsicPageSize != null && (evidenceOnly && evidencePages.length > 0 ? evidencePages : Array.from({ length: totalPages }, (_, i) => i + 1)).map(pageNum => (
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
              annotations={annotationsByPage.get(pageNum) ?? []}
              noteMode={noteMode}
              onCreateNote={(rect, pageSize) => void createNote(pageNum, rect, pageSize)}
              onMoveNote={(id, rects, pageSize) => void moveAnnotation(id, rects, pageSize)}
              onAnnotationClick={(annotation, anchor) => setAnnotationEditor({ annotation, anchor })}
            />
          ))}
          {highlightAction && (
            <div style={{ position: 'fixed', left: highlightAction.anchor.x, top: Math.max(8, highlightAction.anchor.y), zIndex: 50 }}>
              <button
                data-pdf-annotation-control="true"
                onClick={() => void createHighlight()}
                style={floatingActionStyle}
              >
                Highlight
              </button>
            </div>
          )}
          {annotationEditor && (
            <AnnotationPopover
              editor={annotationEditor}
              conceptName={annotationEditor.annotation.scope === 'concept' ? conceptName : 'Source-wide'}
              onClose={() => setAnnotationEditor(null)}
              onSave={patch => void saveAnnotation(annotationEditor.annotation.id, patch)}
              onDelete={() => void deleteAnnotation(annotationEditor.annotation)}
            />
          )}
          {pendingDeletedAnnotations.length > 0 && (
            <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 60, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingDeletedAnnotations.map(annotation => (
                <div key={annotation.id} style={undoToastStyle}>
                  <span>{annotation.type === 'note' ? 'Note' : 'Highlight'} deleted.</span>
                  <button onClick={() => void restoreAnnotation(annotation)} style={undoBtnStyle}>Undo</button>
                </div>
              ))}
            </div>
          )}
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
  annotations, noteMode, onCreateNote, onMoveNote, onAnnotationClick,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  fallbackSize: { width: number; height: number };
  registerRef: (pageNum: number, el: HTMLDivElement | null) => void;
  onMeasured?: (pageNum: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  annotations: PdfAnnotation[];
  noteMode: boolean;
  onCreateNote: (rect: PdfAnnotationRect, pageSize: { width: number; height: number }) => void;
  onMoveNote: (id: number, rects: PdfAnnotationRect[], pageSize: { width: number; height: number }) => void;
  onAnnotationClick: (annotation: PdfAnnotation, anchor: { x: number; y: number }) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const suppressNoteClickRef = useRef<Set<number>>(new Set());
  const dragNoteRef = useRef<{ id: number; base: PdfAnnotationRect; pageRect: DOMRect; startX: number; startY: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [draggingNote, setDraggingNote] = useState<{ id: number; x: number; y: number } | null>(null);
  const boxSize = size ?? fallbackSize;
  const highlightAnnotations = annotations.filter(a => a.type === 'highlight');
  const noteAnnotations = annotations.filter(a => a.type === 'note');

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
          const textTask = new (pdfjs as unknown as {
            TextLayer: new (args: {
              textContentSource: unknown;
              container: HTMLElement;
              viewport: unknown;
            }) => { render: () => Promise<void>; cancel: () => void };
          }).TextLayer({
            textContentSource: textContent,
            container: textLayerEl,
            viewport: vp,
          });
          textTaskRef.current = textTask;
          try { await textTask.render(); } catch { /* cancelled mid-render is fine */ }
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
      onClick={e => {
        if (!noteMode) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        onCreateNote({ x, y, width: 0.025, height: 0.025 }, { width: rect.width, height: rect.height });
      }}
      style={{
        width: boxSize.width,
        height: boxSize.height,
        background: '#fff',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        position: 'relative',
        overflow: 'visible',
        flexShrink: 0,
      }}
    >
      {visible && size && (
        <>
          <canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', top: 0, left: 0 }} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
            {highlightAnnotations.flatMap(annotation =>
              annotation.rects.map((r, idx) => (
                <div
                  key={`${annotation.id}-${idx}`}
                  style={{
                    position: 'absolute',
                    left: `${r.x * 100}%`,
                    top: `${r.y * 100}%`,
                    width: `${r.width * 100}%`,
                    height: `${r.height * 100}%`,
                    background: annotation.color,
                    opacity: 0.32,
                    borderRadius: 2,
                    pointerEvents: 'none',
                  }}
                />
              )),
            )}
          </div>
          <div
            ref={textLayerRef}
            className="textLayer pdf-text-layer"
            style={{
              position: 'absolute', top: 0, left: 0,
              overflow: 'hidden', opacity: 0.999,
              lineHeight: 1, color: 'transparent',
              userSelect: 'text', cursor: 'text',
              zIndex: 2,
            }}
          />
          <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }}>
            {highlightAnnotations.map(annotation => {
              const first = annotation.rects[0];
              if (!first) return null;
              return (
                <button
                  key={`hit-${annotation.id}`}
                  data-pdf-annotation-control="true"
                  onClick={e => {
                    e.stopPropagation();
                    onAnnotationClick(annotation, { x: e.clientX + 8, y: e.clientY + 8 });
                  }}
                  title={annotation.label || annotation.selected_text || 'Edit highlight'}
                  style={{
                    position: 'absolute',
                    left: `max(0px, calc(${first.x * 100}% - 18px))`,
                    top: `${Math.max(0, first.y * 100 - 1.8)}%`,
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: `1px solid ${annotation.color}`,
                    background: 'rgba(15, 23, 42, 0.76)',
                    color: annotation.color,
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                    padding: 0,
                    fontSize: 9,
                    lineHeight: 1,
                  }}
                >
                  H
                </button>
              );
            })}
            {noteAnnotations.map(annotation => {
              const r = annotation.rects[0];
              if (!r) return null;
              const isDragging = draggingNote?.id === annotation.id;
              const displayX = isDragging ? draggingNote.x : r.x;
              const displayY = isDragging ? draggingNote.y : r.y;
              return (
                <button
                  key={annotation.id}
                  data-pdf-annotation-control="true"
                  onClick={e => {
                    e.stopPropagation();
                    if (suppressNoteClickRef.current.has(annotation.id)) {
                      suppressNoteClickRef.current.delete(annotation.id);
                      return;
                    }
                    onAnnotationClick(annotation, { x: e.clientX + 8, y: e.clientY + 8 });
                  }}
                  onPointerDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const pageRect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
                    if (!pageRect || !containerRect) return;
                    const startX = e.clientX;
                    const startY = e.clientY;
                    dragNoteRef.current = { id: annotation.id, base: r, pageRect, startX, startY };
                    const move = (event: PointerEvent) => {
                      const drag = dragNoteRef.current;
                      if (!drag || drag.id !== annotation.id) return;
                      const hasMoved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
                      if (!hasMoved) return;
                      setDraggingNote({
                        id: annotation.id,
                        ...notePositionFromClientPoint(event.clientX, event.clientY, pageRect, containerRect),
                      });
                    };
                    const up = (event: PointerEvent) => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', up);
                      window.removeEventListener('pointercancel', up);
                      const drag = dragNoteRef.current;
                      dragNoteRef.current = null;
                      setDraggingNote(null);
                      if (!drag || drag.id !== annotation.id) return;
                      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
                      if (moved) {
                        const next = notePositionFromClientPoint(
                          event.clientX,
                          event.clientY,
                          drag.pageRect,
                          scrollContainerRef.current?.getBoundingClientRect() ?? drag.pageRect,
                        );
                        suppressNoteClickRef.current.add(annotation.id);
                        onMoveNote(annotation.id, [{ ...drag.base, ...next }], { width: drag.pageRect.width, height: drag.pageRect.height });
                      } else {
                        onAnnotationClick(annotation, { x: event.clientX + 8, y: event.clientY + 8 });
                      }
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up, { once: true });
                    window.addEventListener('pointercancel', up, { once: true });
                  }}
                  title={annotation.note_body || 'Edit note'}
                  style={{
                    position: 'absolute',
                    left: `${displayX * 100}%`,
                    top: `${displayY * 100}%`,
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: `1px solid ${annotation.color}`,
                    background: 'rgba(15, 23, 42, 0.86)',
                    color: annotation.color,
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                    padding: 0,
                    fontSize: 12,
                    lineHeight: 1,
                    boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
                    zIndex: 4,
                  }}
                >
                  !
                </button>
              );
            })}
          </div>
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

function AnnotationPopover({
  editor, conceptName, onClose, onSave, onDelete,
}: {
  editor: AnnotationEditor;
  conceptName: string;
  onClose: () => void;
  onSave: (patch: { label?: string; noteBody?: string; color?: string }) => void;
  onDelete: () => void;
}) {
  const { annotation, anchor } = editor;
  const [label, setLabel] = useState(annotation.label);
  const [noteBody, setNoteBody] = useState(annotation.note_body);
  const [color, setColor] = useState(annotation.color);

  useEffect(() => {
    setLabel(annotation.label);
    setNoteBody(annotation.note_body);
    setColor(annotation.color);
  }, [annotation.id, annotation.label, annotation.note_body, annotation.color]);

  return (
    <div
      style={{
        position: 'fixed',
        left: Math.min(anchor.x, window.innerWidth - 300),
        top: Math.min(anchor.y, window.innerHeight - 250),
        width: 280,
        zIndex: 55,
        background: 'rgba(13,13,22,0.72)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid #312e81',
        borderRadius: 6,
        boxShadow: '0 16px 50px rgba(0,0,0,0.55)',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#e2e8f0' }}>
          {annotation.type === 'note' ? 'Sticky note' : 'Highlight'}
        </div>
        <span style={{
          maxWidth: 140,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          border: '1px solid #312e81',
          borderRadius: 999,
          color: '#c7d2fe',
          background: 'rgba(49,46,129,0.28)',
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 7px',
        }}>
          {conceptName}
        </span>
        <button onClick={onClose} style={popoverIconBtnStyle}>x</button>
      </div>
      {annotation.type === 'highlight' && (
        <>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Selected text
          </div>
          <div style={{ maxHeight: 80, overflowY: 'auto', color: '#cbd5e1', fontSize: 12, lineHeight: 1.45, marginBottom: 10, padding: 8, background: 'rgba(17,24,39,0.4)', border: '1px solid #1f2937', borderRadius: 4 }}>
            {annotation.selected_text || '(empty selection)'}
          </div>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Optional label"
            style={popoverInputStyle}
          />
        </>
      )}
      <textarea
        value={noteBody}
        onChange={e => setNoteBody(e.target.value)}
        placeholder={annotation.type === 'note' ? 'Write a sticky note...' : 'Add a comment...'}
        style={{ ...popoverInputStyle, minHeight: 78, resize: 'vertical', marginTop: annotation.type === 'highlight' ? 8 : 0 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <input
          type="color"
          value={color}
          onChange={e => setColor(e.target.value)}
          title="Annotation color"
          style={{ width: 30, height: 28, padding: 0, background: 'transparent', border: '1px solid #263244', borderRadius: 4 }}
        />
        <button
          onClick={() => onSave({ label, noteBody, color })}
          style={popoverPrimaryBtnStyle}
        >
          Save
        </button>
        <button
          onClick={onDelete}
          style={popoverDangerBtnStyle}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function Header({ data, conceptName, extras }: { data: SourceEvidence; conceptName: string; extras: React.ReactNode }) {
  return (
    <div style={{
      padding: '8px 14px',
      borderBottom: GLASS_BORDER,
      background: GLASS_PANEL_BG,
      backdropFilter: GLASS_BLUR,
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

const activeAnnotBtnStyle: React.CSSProperties = {
  ...navBtnStyle,
  background: '#1e1b4b',
  border: '1px solid #6366f1',
  color: '#c7d2fe',
};

const floatingActionStyle: React.CSSProperties = {
  background: '#1e1b4b',
  border: '1px solid #6366f1',
  borderRadius: 4,
  color: '#e0e7ff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  padding: '6px 10px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
};

const popoverInputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(17,24,39,0.45)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '1px solid #263244',
  borderRadius: 4,
  color: '#e2e8f0',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
  padding: '7px 9px',
};

const popoverPrimaryBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: '#1e1b4b',
  border: '1px solid #6366f1',
  borderRadius: 4,
  color: '#c7d2fe',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 700,
  padding: '6px 12px',
};

const popoverDangerBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #7f1d1d',
  borderRadius: 4,
  color: '#fca5a5',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 700,
  padding: '6px 12px',
};

const popoverIconBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: '1px solid #263244',
  borderRadius: 4,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: 0,
  lineHeight: 1,
};

const undoToastStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: '#111827',
  border: '1px solid #312e81',
  borderRadius: 6,
  color: '#cbd5e1',
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
};

const undoBtnStyle: React.CSSProperties = {
  background: '#1e1b4b',
  border: '1px solid #6366f1',
  borderRadius: 4,
  color: '#c7d2fe',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 700,
  padding: '3px 9px',
};

const panelStyle: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#6b7280', fontSize: 13,
};
