import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vite ?url import returns a string path the worker loader uses
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl as unknown as string;

// Read-only page preview for Ask citations: opens the source PDF at the cited
// page(s) and highlights the verified quote. Deliberately separate from the
// concept-bound PdfViewer (evidence rail, annotations, notes): nothing here
// writes anything.

export interface CitationTarget {
  sourceId: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  quote: string | null;      // verified quote to highlight, if any
  nonce: number;             // re-trigger scroll for the same target
}

// LOCATING a quote that the service already verified. pdf.js text layers
// emit math glyphs (∗, ⊛, …) as separate spans out of reading order, so an
// exact-text match fails where the layout text (what was verified) matches.
// Locate on letters and digits only: symbols, punctuation, quote styles and
// line-break hyphens drop out, and the TeX epsilon glyph is folded.
function alnumStream(s: string, unitOf: (i: number) => number): { text: string; owner: number[] } {
  let text = '';
  const owner: number[] = [];
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    for (const c of ch.normalize('NFKC').toLowerCase()) {
      const f = c === 'ǫ' ? 'ε' : c;
      if (/[\p{L}\p{N}]/u.test(f)) { text += f; owner.push(unitOf(i)); }
    }
    i += ch.length;
  }
  return { text, owner };
}

// Quotes with fewer letters/digits than this could match almost anywhere.
const MIN_LOCATE_CHARS = 8;

// Indices of the text-layer spans covering `quote` (in order), or [].
export function spansForQuote(spanTexts: string[], quote: string): number[] {
  let s = '';
  const unit: number[] = [];
  spanTexts.forEach((t, k) => { for (let c = 0; c < t.length; c++) unit.push(k); s += t; });
  const hay = alnumStream(s, i => unit[i]);
  const pieces = quote.split(/\s*(?:\.\.\.|…)\s*/).map(p => alnumStream(p, () => 0).text).filter(Boolean);
  if (pieces.reduce((n, p) => n + p.length, 0) < MIN_LOCATE_CHARS) return [];
  let from = 0;
  let first = -1;
  for (const p of pieces) {
    const at = hay.text.indexOf(p, from);
    if (at < 0) return [];
    if (first < 0) first = at;
    from = at + p.length;
  }
  const lo = hay.owner[first];
  const hi = hay.owner[from - 1];
  const out: number[] = [];
  for (let k = lo; k <= hi; k++) if (/[\p{L}\p{N}]/u.test(spanTexts[k] ?? '')) out.push(k);
  return out;
}

// One open document at a time; switching sources destroys the previous one.
let cached: { sourceId: number; doc: Promise<pdfjs.PDFDocumentProxy> } | null = null;
function loadDoc(sourceId: number): Promise<pdfjs.PDFDocumentProxy> {
  if (cached?.sourceId === sourceId) return cached.doc;
  void cached?.doc.then(d => d.destroy()).catch(() => undefined);
  const doc = window.api.sources.bytes(sourceId).then(bytes => pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise);
  cached = { sourceId, doc };
  doc.catch(() => { if (cached?.doc === doc) cached = null; });
  return doc;
}

export default function SourcePagePreview({ target, onClose }: { target: CitationTarget; onClose: () => void }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number]>([target.pageStart, target.pageEnd]);
  const [width, setWidth] = useState(0);
  const [found, setFound] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    loadDoc(target.sourceId)
      .then(d => { if (!cancelled) setDoc(d); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [target.sourceId]);

  useEffect(() => {
    setRange([target.pageStart, target.pageEnd]);
    setFound(null);
  }, [target.pageStart, target.pageEnd, target.nonce]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pages: number[] = [];
  if (doc) for (let p = Math.max(1, range[0]); p <= Math.min(doc.numPages, range[1]); p++) pages.push(p);

  return (
    <section style={{ width: '46%', minWidth: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(31,41,55,0.72)', background: 'rgba(4,6,26,0.55)', backdropFilter: 'blur(14px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(31,41,55,0.72)', fontSize: 12, color: 'var(--text-secondary)' }}>
        <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={target.title}>
          {target.title}
        </span>
        <button onClick={() => setRange(([a, b]) => [Math.max(1, a - 1), b])} disabled={range[0] <= 1} style={navBtn} title="Show the previous page too">‹ p. {Math.max(1, range[0] - 1)}</button>
        <span style={{ whiteSpace: 'nowrap' }}>{range[0] === range[1] ? `p. ${range[0]}` : `pp. ${range[0]}–${range[1]}`}</span>
        <button onClick={() => setRange(([a, b]) => [a, Math.min(doc?.numPages ?? b + 1, b + 1)])} disabled={!!doc && range[1] >= doc.numPages} style={navBtn} title="Show the next page too">p. {range[1] + 1} ›</button>
        <button onClick={onClose} style={{ ...navBtn, fontSize: 14 }} title="Close the source preview">×</button>
      </div>
      {target.quote && found === false && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-warning)' }}>
          The quote was verified against the extracted text but couldn't be located on the rendered page; showing the cited page.
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {error && <div style={{ fontSize: 12, color: 'var(--text-danger)' }}>Could not open the PDF: {error}</div>}
        {!doc && !error && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Opening…</div>}
        {doc && width > 0 && pages.map(p => (
          <PreviewPage
            key={`${target.sourceId}:${p}`}
            doc={doc} pageNum={p} width={width - 24}
            quote={target.quote} nonce={target.nonce}
            onHighlight={(el, ok) => {
              if (ok) { setFound(true); el?.scrollIntoView({ block: 'center' }); }
              else setFound(f => (f === true ? f : p === pages[pages.length - 1] ? false : f));
            }}
          />
        ))}
      </div>
    </section>
  );
}

function PreviewPage({ doc, pageNum, width, quote, nonce, onHighlight }: {
  doc: pdfjs.PDFDocumentProxy; pageNum: number; width: number; quote: string | null; nonce: number;
  onHighlight: (el: HTMLElement | null, found: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Array<{ left: number; top: number; width: number; height: number }>>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textTask: { cancel: () => void } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.max(0.3, width / base.width) });
        setSize({ w: vp.width, h: vp.height });
        const canvas = canvasRef.current!;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTask = page.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
        if (cancelled) return;

        const tl = textRef.current!;
        tl.innerHTML = '';
        tl.style.width = `${vp.width}px`;
        tl.style.height = `${vp.height}px`;
        tl.style.setProperty('--scale-factor', String(vp.scale));
        tl.style.setProperty('--total-scale-factor', String(vp.scale));
        const textContent = await page.getTextContent();
        if (cancelled) return;
        textTask = new (pdfjs as unknown as {
          TextLayer: new (args: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) =>
            { render: () => Promise<void>; cancel: () => void };
        }).TextLayer({ textContentSource: textContent, container: tl, viewport: vp });
        try { await textTask.render(); } catch { return; }
        if (cancelled || !quote) return;

        const spans = Array.from(tl.querySelectorAll<HTMLElement>('span')).filter(sp => !sp.querySelector('span'));
        const hit = spansForQuote(spans.map(sp => sp.textContent ?? ''), quote);
        const wrap = wrapRef.current!.getBoundingClientRect();
        const next = hit.map(k => {
          const r = spans[k].getBoundingClientRect();
          return { left: r.left - wrap.left, top: r.top - wrap.top, width: r.width, height: r.height };
        });
        setBoxes(next);
        onHighlightRef.current(next.length ? spans[hit[0]] : null, next.length > 0);
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== 'RenderingCancelledException') {
          console.error(`[SourcePagePreview] render error on page ${pageNum}`, e);
        }
      }
    })();
    return () => { cancelled = true; renderTask?.cancel(); textTask?.cancel(); setBoxes([]); };
  }, [doc, pageNum, width, quote, nonce]);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>p. {pageNum}</div>
      <div ref={wrapRef} style={{ position: 'relative', width: size?.w ?? width, height: size?.h ?? width * 1.3, background: '#fff', boxShadow: '0 4px 18px rgba(0,0,0,0.4)' }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
          {boxes.map((b, i) => (
            <div key={i} style={{ position: 'absolute', left: b.left - 1, top: b.top - 1, width: b.width + 2, height: b.height + 2, background: 'rgba(34,197,94,0.32)', borderRadius: 2 }} />
          ))}
        </div>
        <div
          ref={textRef}
          className="textLayer pdf-text-layer"
          style={{ position: 'absolute', top: 0, left: 0, overflow: 'hidden', opacity: 0.999, lineHeight: 1, color: 'transparent', userSelect: 'text', cursor: 'text', zIndex: 2 }}
        />
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid rgba(55,65,120,0.6)', color: 'var(--text-accent)',
  borderRadius: 5, padding: '1px 7px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
};
