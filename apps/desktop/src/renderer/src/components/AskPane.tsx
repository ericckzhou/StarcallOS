import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskHistoryEntry, AskResult, RagProgress, RagStatus } from '@starcall/shared';
import LibraryIndexPanel, { RAG_INDEX_CHANGED } from './LibraryIndexPanel';
import SourcePagePreview, { type CitationTarget } from './SourcePagePreview';

// Local Ask: question → retrieved passages → local-model answer whose every
// [n] marker has been verified against the passage text (services/ask.ts).
// Nothing here talks to a cloud provider; the main process enforces that.

const SELECTED_KEY = 'starcall.ask.sources';

type Status = AskResult['status'];
const STATUS_META: Record<Status, { label: string; color: string; hint: string }> = {
  grounded:       { label: 'Grounded',             color: '#22c55e', hint: 'Every citation quotes its passage verbatim.' },
  partial:        { label: 'Partially grounded',   color: '#f59e0b', hint: 'Some citations could not be verified and were removed.' },
  qualified:      { label: 'Sources partly answer this', color: '#eab308', hint: 'The passages do not fully answer the question; the answer says what they do cover, and every citation was verified.' },
  unsupported:    { label: 'Unsupported',          color: '#ef4444', hint: 'The model answered, but none of its citations could be verified. Treat the answer as unreliable.' },
  insufficient:   { label: 'Not in sources',       color: '#94a3b8', hint: 'The model reports that the retrieved passages do not answer this.' },
  no_passages:    { label: 'No matching passages', color: '#94a3b8', hint: 'Retrieval found nothing in the selected sources; no model call was made.' },
  retrieval_only: { label: 'Passages only',        color: '#818cf8', hint: 'The local model is unavailable, so only the retrieved passages are shown.' },
};

const DROP_REASON: Record<string, string> = {
  unknown_passage: 'cited a passage that was not provided',
  quote_not_found: 'quote not found in the passage',
  quote_too_short: 'quote too short to verify',
  marker_without_quote: 'marker had no supporting quote',
};

function loadSelected(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch { return []; }
}

const pages = (a: number, b: number) => (a === b ? `p. ${a}` : `pp. ${a}–${b}`);

// Highlight the spans the service verified (original-text offsets), so what
// is marked is exactly what was checked — no client-side re-matching.
function highlight(text: string, spans: Array<[number, number]>): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let at = 0;
  [...spans].sort((x, y) => x[0] - y[0]).forEach(([s, e], i) => {
    if (s < at || e > text.length) return;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i} style={{ background: 'rgba(34,197,94,0.22)', color: 'var(--text)', borderRadius: 3, padding: '0 1px' }}>{text.slice(s, e)}</mark>);
    at = e;
  });
  out.push(text.slice(at));
  return out;
}

// Set when Ask is opened from a concept ("Ask about this").
export interface AskContext { conceptId: number; name: string; sourceId: number | null }

// Starter questions follow the concept's own Overview fields (definition / why
// it exists / what breaks / where it reappears). They only fill the box — the
// user still chooses to ask.
function starters(name: string): string[] {
  // Phrased so the verb never agrees with the concept name ("Regular
  // expressions" would make "What is …" / "Why does … exist" ungrammatical).
  return [`Define ${name}.`, `What is the purpose of ${name}?`, `What goes wrong without ${name}?`, `Give an example of ${name}.`];
}

function ago(sqlTime: string): string {
  const t = Date.parse(sqlTime.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export default function AskPane({ context = null, onClearContext }: { context?: AskContext | null; onClearContext?: () => void }) {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [selected, setSelected] = useState<number[]>(loadSelected);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<RagProgress | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState<Set<number>>(new Set());
  const [focusN, setFocusN] = useState<number | null>(null);
  const passageRefs = useRef(new Map<number, HTMLDivElement>());
  const [history, setHistory] = useState<AskHistoryEntry[]>([]);
  // Citation → source page preview (PDF sources only; text sources have no pages).
  const [preview, setPreview] = useState<CitationTarget | null>(null);
  const [pdfSources, setPdfSources] = useState<Set<number>>(new Set());
  useEffect(() => {
    window.api.sources.list()
      .then(list => setPdfSources(new Set(list.filter(s => /\.pdf$/i.test(s.file_path)).map(s => s.id))))
      .catch(() => setPdfSources(new Set()));
  }, []);

  const refreshHistory = useCallback(() => {
    if (!context) { setHistory([]); return; }
    window.api.rag.history(context.conceptId).then(setHistory).catch(() => setHistory([]));
  }, [context]);

  // Opening Ask from a concept scopes it to that concept's source and starts
  // fresh; leaving the concept keeps the user's own source selection.
  useEffect(() => {
    if (!context) return;
    if (context.sourceId != null) setSelected([context.sourceId]);
    setQuestion('');
    setResult(null);
    setError(null);
  }, [context]);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const refreshStatus = useCallback(() => {
    window.api.rag.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    window.addEventListener(RAG_INDEX_CHANGED, refreshStatus);
    return () => window.removeEventListener(RAG_INDEX_CHANGED, refreshStatus);
  }, [refreshStatus]);
  useEffect(() => window.api.rag.onProgress(setProgress), []);

  // Drop selections for sources that no longer exist.
  const validSelected = useMemo(
    () => selected.filter(id => status?.sources.some(s => s.source_id === id) ?? true),
    [selected, status],
  );
  useEffect(() => {
    try { localStorage.setItem(SELECTED_KEY, JSON.stringify(validSelected)); } catch { /* ignore */ }
  }, [validSelected]);

  const scope = status?.sources.filter(s => validSelected.length === 0 || validSelected.includes(s.source_id)) ?? [];
  const unindexed = scope.filter(s => s.chunks === 0);
  const titleById = new Map(status?.sources.map(s => [s.source_id, s.title]) ?? []);

  function toggle(id: number) {
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  async function indexSource(id: number) {
    setIndexing(prev => new Set(prev).add(id));
    try {
      const r = await window.api.rag.indexSource(id);
      if (!r.ok) setError(`Indexing "${titleById.get(id) ?? id}" failed: ${r.error}`);
    } finally {
      setIndexing(prev => { const n = new Set(prev); n.delete(id); return n; });
      window.dispatchEvent(new Event(RAG_INDEX_CHANGED));
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    setProgress(null);
    setFocusN(null);
    try {
      setPreview(null);
      setResult(await window.api.rag.ask({
        question: q,
        sourceIds: validSelected.length ? validSelected : undefined,
        conceptId: context?.conceptId,
      }));
      if (context) refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
      setProgress(null);
      refreshStatus();
    }
  }

  // Open the cited page in the side preview, highlighting `quote` (verified).
  function openPage(p: { source_id: number; source_title: string; page_start: number; page_end: number }, quote: string | null) {
    if (!pdfSources.has(p.source_id)) return;
    setPreview({ sourceId: p.source_id, title: p.source_title, pageStart: p.page_start, pageEnd: p.page_end, quote, nonce: Date.now() });
  }

  // A citation scrolls to its passage card and, for PDFs, opens the page with
  // that passage's (first) verified quote highlighted.
  function jumpTo(n: number, quote?: string) {
    setFocusN(n);
    passageRefs.current.get(n)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const p = result?.passages.find(x => x.n === n);
    if (p) openPage(p, quote ?? result?.citations.find(c => c.n === n)?.quote ?? null);
  }

  // Render [n] / [n, m] markers in the answer as clickable chips.
  function renderAnswer(text: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let at = 0;
    for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      out.push(text.slice(at, m.index));
      m[1].split(',').map(x => Number(x.trim())).forEach(n => out.push(
        <button key={`${m.index}-${n}`} onClick={() => jumpTo(n)} title={`Show passage ${n}`} style={chip}>{n}</button>,
      ));
      at = (m.index ?? 0) + m[0].length;
    }
    out.push(text.slice(at));
    return out;
  }

  const spansByN = new Map<number, Array<[number, number]>>();
  for (const c of result?.citations ?? []) spansByN.set(c.n, [...(spansByN.get(c.n) ?? []), [c.start, c.end]]);
  const meta = result ? STATUS_META[result.status] : null;

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
      <aside style={{ width: 260, flexShrink: 0, borderRight: '1px solid rgba(31,41,55,0.72)', background: 'rgba(4,6,26,0.42)', backdropFilter: 'blur(14px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid rgba(31,41,55,0.72)' }}>
          <span style={label}>Passage index</span>
          <div style={{ marginTop: 4 }}><LibraryIndexPanel compact /></div>
        </div>
        <div style={{ padding: '12px 14px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={label}>Sources</span>
          <button onClick={() => setSelected([])} disabled={validSelected.length === 0} style={linkBtn} title="Search every source">
            {validSelected.length === 0 ? 'All' : 'Use all'}
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {(status?.sources ?? []).map(s => {
            const on = validSelected.includes(s.source_id);
            return (
              <div key={s.source_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', borderRadius: 6, background: on ? 'rgba(129,140,248,0.12)' : 'transparent' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(s.source_id)} aria-label={`Ask ${s.title}`} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.title}>{s.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {s.chunks === 0 ? 'not indexed' : `${s.chunks} passages${status?.embeddingsEnabled ? ` · ${s.embedded} embedded` : ''}`}
                    {s.stale && <span style={{ color: 'var(--text-warning)' }} title="Indexed by an older parser; Index library re-indexes its passages"> · outdated</span>}
                  </div>
                </div>
                {s.chunks === 0 && (
                  <button onClick={() => indexSource(s.source_id)} disabled={indexing.has(s.source_id)} style={smallBtn} title="Build the passage index for this source (re-reads the file; candidates and concepts are unchanged)">
                    {indexing.has(s.source_id) ? '…' : 'Index'}
                  </button>
                )}
              </div>
            );
          })}
          {status && status.sources.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Add a source first.</div>}
        </div>
        <div style={{ borderTop: '1px solid rgba(31,41,55,0.72)', padding: '10px 14px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div title={status?.askBaseUrl ?? undefined}>
            Answers: {status?.askModel ? <span style={{ color: 'var(--text)' }}>{status.askModel}</span> : <span style={{ color: 'var(--text-warning)' }}>no local model (passages only)</span>}
          </div>
          <div>
            Retrieval: {status?.embeddingsEnabled ? <>hybrid · <span style={{ color: 'var(--text)' }}>{status.embeddingModel}</span></> : 'keyword (embeddings off)'}
          </div>
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>Runs locally. Set the model in Settings → Local provider.</div>
        </div>
      </aside>

      <main style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={panel}>
            {context && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ ...badge, color: 'var(--text-accent)', borderColor: 'rgba(129,140,248,0.5)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  About: {context.name}
                  <button onClick={onClearContext} title="Stop asking about this concept" style={{ ...linkBtn, color: 'var(--text-secondary)', fontSize: 12 }}>×</button>
                </span>
                {!question.trim() && starters(context.name).map(s => (
                  <button key={s} onClick={() => setQuestion(s)} style={smallBtn} title="Use this question (you still choose to ask)">{s}</button>
                ))}
              </div>
            )}
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void ask(); } }}
              placeholder={context ? `Ask about ${context.name}…` : 'Ask a question about your sources…'}
              rows={3}
              maxLength={2000}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'rgba(2,4,18,0.45)', border: '1px solid rgba(55,65,120,0.6)', borderRadius: 8, color: 'var(--text)', padding: '10px 12px', fontSize: 14, fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {validSelected.length === 0 ? 'All sources' : `${validSelected.length} source${validSelected.length === 1 ? '' : 's'}`}
                {unindexed.length > 0 && <span style={{ color: 'var(--text-warning)' }}> · {unindexed.length} not indexed (skipped)</span>}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>Ctrl+Enter</span>
              <button onClick={() => void ask()} disabled={asking || !question.trim()} style={primaryBtn}>{asking ? 'Asking…' : 'Ask'}</button>
            </div>
            {asking && progress && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                Embedding passages for “{titleById.get(progress.sourceId) ?? progress.sourceId}”: {progress.done}/{progress.total}
                <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(31,41,55,0.5)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: 'var(--indigo-400)' }} />
                </div>
              </div>
            )}
          </div>

          {error && <div style={{ ...panel, borderColor: 'rgba(239,68,68,0.5)', color: 'var(--text-danger)', fontSize: 12 }}>{error}</div>}

          {context && history.length > 0 && (
            <details style={{ ...panel, padding: '10px 14px' }} open={!result}>
              <summary style={{ ...label, cursor: 'pointer' }}>Earlier questions about {context.name} ({history.length})</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
                {history.map(h => {
                  const m = STATUS_META[h.result.status];
                  const active = result?.history_id === h.id;
                  return (
                    <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, background: active ? 'rgba(129,140,248,0.12)' : 'transparent' }}>
                      <button onClick={() => { setResult({ ...h.result, history_id: h.id }); setFocusN(null); }} title="Show this answer" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 12, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }}>
                        {h.result.question}
                      </button>
                      <span title={m.hint} style={{ fontSize: 10, fontWeight: 700, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ago(h.created_at)}</span>
                      <button
                        onClick={async () => {
                          await window.api.rag.historyDelete(h.id);
                          if (result?.history_id === h.id) setResult(null);
                          refreshHistory();
                        }}
                        title="Remove this question from the history"
                        style={{ ...linkBtn, color: 'var(--text-muted)', fontSize: 13 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {result && meta && (
            <>
              <div style={panel}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span title={meta.hint} style={{ ...badge, color: meta.color, borderColor: meta.color }}>{meta.label}</span>
                  <span
                    title={result.retrieval.vector_error ?? 'Keyword (BM25) and vector results fused'}
                    style={{ ...badge, color: 'var(--text-secondary)', borderColor: 'rgba(148,163,184,0.4)' }}
                  >
                    {result.retrieval.mode_used === 'hybrid' ? 'Hybrid retrieval' : 'Keyword only'}
                  </span>
                  {result.model && result.status !== 'retrieval_only' && result.status !== 'no_passages' && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{result.model}</span>
                  )}
                  {result.answer && (
                    <SaveAsNote
                      key={result.history_id ?? result.question}
                      result={result}
                      defaultConcept={context ? { id: context.conceptId, name: context.name } : null}
                    />
                  )}
                </div>
                {result.answer ? (
                  <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{renderAnswer(result.answer)}</div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{meta.hint}</div>
                )}
                {result.citations.length > 0 && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={label}>Verified sources</span>
                    {result.citations.map((c, i) => {
                      const p = result.passages.find(x => x.n === c.n);
                      return (
                        <button key={i} onClick={() => jumpTo(c.n, c.quote)} title={pdfSources.has(c.source_id) ? 'Open the page with this quote highlighted' : 'Show the passage'} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: '2px 0', cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                          <span style={chip}>{c.n}</span>
                          <span style={{ color: 'var(--text-soft)' }}>{p?.source_title}</span>, {pages(c.page_start, c.page_end)} — <i>“{c.quote}”</i>
                        </button>
                      );
                    })}
                  </div>
                )}
                {result.generation_error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-warning)' }}>Local model: {result.generation_error}</div>
                )}
                {result.index_warning && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-warning)' }}>{result.index_warning}</div>}
                {result.dropped.length > 0 && (
                  <details style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
                    <summary style={{ cursor: 'pointer' }}>{result.dropped.length} citation{result.dropped.length === 1 ? '' : 's'} removed (could not be verified)</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {result.dropped.map((d, i) => (
                        <li key={i}>[{d.n ?? '?'}] {DROP_REASON[d.reason] ?? d.reason}{d.quote ? <> — <i>“{d.quote}”</i></> : null}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {result.passages.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={label}>Passages</span>
                  {result.passages.map(p => {
                    const cited = spansByN.has(p.n);
                    return (
                      <div
                        key={p.chunk_id}
                        ref={el => { if (el) passageRefs.current.set(p.n, el); else passageRefs.current.delete(p.n); }}
                        style={{ ...panel, padding: '10px 14px', borderColor: focusN === p.n ? '#818cf8' : cited ? 'rgba(34,197,94,0.35)' : panel.borderColor }}
                      >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                          <span style={{ ...chip, cursor: 'default' }}>{p.n}</span>
                          <span style={{ color: 'var(--text)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40%' }} title={p.source_title}>{p.source_title}</span>
                          {p.section_path.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{p.section_path.join(' › ')}</span>}
                          <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{pages(p.page_start, p.page_end)}</span>
                          {pdfSources.has(p.source_id) && (
                            <button
                              onClick={() => openPage(p, result.citations.find(c => c.n === p.n)?.quote ?? null)}
                              style={{ ...linkBtn, whiteSpace: 'nowrap' }}
                              title="Open this page in the source PDF"
                            >Open page ↗</button>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-soft)', whiteSpace: 'pre-wrap' }}>
                          {highlight(p.text, spansByN.get(p.n) ?? [])}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {preview && <SourcePagePreview target={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// Learning-loop hook: keep a verified answer as a note on a concept from one
// of the cited sources. The note is ordinary user-owned text (editable, never
// rewritten by extraction) and carries the citations with their pages.
// From "Ask about this" the asked-about concept is the one-click default; the
// ▾ picker still allows any concept from the cited sources.
function SaveAsNote({ result, defaultConcept }: { result: AskResult; defaultConcept: { id: number; name: string } | null }) {
  const [open, setOpen] = useState(false);
  const [concepts, setConcepts] = useState<Array<{ id: number; name: string; source: string }>>([]);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const sourceIds = [...new Set((result.citations.length ? result.citations : result.passages).map(c => c.source_id))];
    const titles = new Map(result.passages.map(p => [p.source_id, p.source_title]));
    Promise.all(sourceIds.map(id => window.api.concepts.bySource(id).then(cs => cs.map(c => ({ id: c.id, name: c.name, source: titles.get(id) ?? '' })))))
      .then(lists => setConcepts(lists.flat().sort((a, b) => a.name.localeCompare(b.name))));
  }, [open, result]);

  async function save(conceptId: number, name: string) {
    const lines = result.citations.map(c => {
      const p = result.passages.find(x => x.n === c.n);
      return `[${c.n}] ${p?.source_title ?? ''}, ${pages(c.page_start, c.page_end)} — “${c.quote}”`;
    });
    const body = `${result.answer ?? ''}\n\n${lines.length ? `Sources:\n${lines.join('\n')}` : '(no verified citations)'}`;
    await window.api.concepts.notes.create({ conceptId, heading: `Q: ${result.question}`.slice(0, 200), body });
    window.dispatchEvent(new Event('starcall:notesChanged'));
    setSaved(name);
    setOpen(false);
  }

  const q = query.trim().toLowerCase();
  const shown = concepts.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 30);
  return (
    <span style={{ marginLeft: 'auto', position: 'relative' }}>
      {saved && !open && <span style={{ fontSize: 11, color: 'var(--green-500)', marginRight: 8 }}>Saved to {saved}</span>}
      {defaultConcept ? (
        <>
          <button onClick={() => void save(defaultConcept.id, defaultConcept.name)} style={{ ...smallBtn, borderRadius: '6px 0 0 6px' }} title={`Save this answer as a note on ${defaultConcept.name}`}>+ Note</button>
          <button onClick={() => setOpen(o => !o)} style={{ ...smallBtn, borderLeft: 'none', borderRadius: '0 6px 6px 0', padding: '2px 6px' }} title="Save to a different concept" aria-label="Save to a different concept">▾</button>
        </>
      ) : (
        <button onClick={() => setOpen(o => !o)} style={smallBtn} title="Save this answer as a note on a concept">+ Note</button>
      )}
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 280, zIndex: 20, background: 'rgba(8,10,34,0.96)', border: '1px solid rgba(55,65,120,0.7)', borderRadius: 8, padding: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Find concept…" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(2,4,18,0.5)', border: '1px solid rgba(55,65,120,0.6)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 12 }} />
          <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 6 }}>
            {shown.map(c => (
              <button key={c.id} className="rel-opt" onClick={() => void save(c.id, c.name)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text)', padding: '5px 6px', fontSize: 12, borderRadius: 4, cursor: 'pointer' }}>
                {c.name} <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{c.source}</span>
              </button>
            ))}
            {concepts.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 6 }}>No promoted concepts in the cited sources.</div>}
          </div>
        </div>
      )}
    </span>
  );
}

const panel: React.CSSProperties & { borderColor: string } = {
  background: 'rgba(4,6,26,0.55)', backdropFilter: 'blur(14px)', border: '1px solid rgba(35,42,85,0.65)',
  borderColor: 'rgba(35,42,85,0.65)', borderRadius: 10, padding: '14px 16px',
};
const label: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const badge: React.CSSProperties = { fontSize: 11, fontWeight: 700, border: '1px solid', borderRadius: 999, padding: '2px 9px' };
const chip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 16, margin: '0 2px',
  padding: '0 4px', borderRadius: 4, fontSize: 10, fontWeight: 700, verticalAlign: 'super',
  background: 'rgba(129,140,248,0.18)', color: 'var(--text-accent)', border: '1px solid rgba(129,140,248,0.4)', cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = { background: '#4f46e5', border: '1px solid var(--border-accent)', color: '#fff', borderRadius: 7, padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const smallBtn: React.CSSProperties = { background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.4)', color: 'var(--text-accent)', borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--indigo-400)', fontSize: 11, cursor: 'pointer', padding: 0 };
