import React, { useState } from 'react';
import LatexMath from '../LatexMath';
import {
  BUCKET_COLOR,
  RELATION_COLOR,
  SIGNAL_COLOR,
  confColor,
  type Bucket,
  type ConceptCandidate,
  type EquationCandidate,
  type MisconceptionCandidate,
  type RelationCandidate,
} from './shared';

export function ConceptsPanel({ filtered, totalConcepts, extractMsg, expanded, setExpanded, busy, equationsByTerm, act, llmKeepIds }: {
  filtered: Array<ConceptCandidate & { bucket?: Bucket }>;
  totalConcepts: number;
  extractMsg: string | null;
  expanded: number | null;
  setExpanded: (n: number | null) => void;
  busy: Set<number>;
  equationsByTerm: Map<string, EquationCandidate[]>;
  act: (id: number, fn: () => Promise<unknown>) => Promise<void>;
  llmKeepIds: Set<number> | null;
}) {
  if (filtered.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>
        {totalConcepts === 0
          ? 'No candidates for this source. Click "Re-extract" on the source in the left panel to (re-)parse it.'
          : 'All candidates filtered out. Lower the confidence threshold.'}
        {extractMsg && (
          <div style={{ marginTop: 12, color: '#9ca3af', fontSize: 11 }}>{extractMsg}</div>
        )}
      </div>
    );
  }

  return (
    <>
      {filtered.map(c => {
        const isOpen = expanded === c.id;
        const isBusy = busy.has(c.id);
        const topQuote = c.evidence[0]?.quote ?? '';
        const attachedEqs = equationsByTerm.get(c.normalized) ?? [];
        const llmKept = !!llmKeepIds?.has(c.id);
        return (
          <div key={c.id} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setExpanded(isOpen ? null : c.id)}
                style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 11, width: 14 }}
              >
                {isOpen ? 'v' : '>'}
              </button>
              <div title={`concept_score ${(c.concept_score ?? 0).toFixed(2)} (heading*0.35 + domain*0.25 + localCtx*0.20 + recurrence*0.10 + phrase*0.10)`} style={{
                minWidth: 36, textAlign: 'right', fontFamily: 'monospace',
                fontSize: 12, color: confColor(c.final_score ?? c.concept_score ?? c.confidence), fontWeight: 600,
              }}>
                {(c.final_score ?? c.concept_score ?? c.confidence).toFixed(2)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.term}
                </div>
                <div style={{ marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>x{c.mention_count}</span>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>p.{c.first_page}</span>
                  {c.section_path.length > 0 && (
                    <span style={{ fontSize: 10, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
                      {c.section_path.join(' > ')}
                    </span>
                  )}
                  {c.signals.map(s => (
                    <span key={s} style={{
                      fontSize: 9, color: SIGNAL_COLOR[s] ?? '#6b7280',
                      border: `1px solid ${SIGNAL_COLOR[s] ?? '#374151'}`,
                      borderRadius: 2, padding: '1px 5px',
                    }}>
                      {s.replace(/_/g, ' ')}
                    </span>
                  ))}
                  {(c.labels ?? []).slice(0, 5).map(label => (
                    <span key={label} style={{
                      fontSize: 9, color: label.includes('fragment') || label.includes('caption') || label.includes('toc') || label.includes('low_context') ? '#fca5a5' : '#93c5fd',
                      border: `1px solid ${label.includes('fragment') || label.includes('caption') || label.includes('toc') || label.includes('low_context') ? '#7f1d1d' : '#1d4ed8'}`,
                      borderRadius: 2, padding: '1px 5px',
                    }}>
                      {label.replace(/_/g, ' ')}
                    </span>
                  ))}
                  {attachedEqs.length > 0 && (
                    <span style={{
                      fontSize: 9, color: '#fbbf24',
                      border: '1px solid #b45309',
                      borderRadius: 2, padding: '1px 5px',
                    }}>
                      f x{attachedEqs.length}
                    </span>
                  )}
                  {c.bucket && (c.bucket === 'low' || c.bucket === 'suspicious') && (
                    <span style={{
                      fontSize: 9, color: BUCKET_COLOR[c.bucket],
                      border: `1px solid ${BUCKET_COLOR[c.bucket]}`,
                      borderRadius: 2, padding: '1px 5px',
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                    }}>
                      {c.bucket}
                    </span>
                  )}
                  {c.reject_reasons && c.reject_reasons.length > 0 && c.reject_reasons.map(r => (
                    <span
                      key={r}
                      title="Deterministic reject reason. Lower the score so the LLM filter / promote gate skips this."
                      style={{
                        fontSize: 9, color: '#fca5a5',
                        border: '1px solid #7f1d1d',
                        borderRadius: 2, padding: '1px 5px',
                        fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                      }}>
                      {r}
                    </span>
                  ))}
                  {llmKept && (
                    <span title="Kept by your saved LLM topic-fit filter" style={{
                      fontSize: 9, color: '#c7d2fe',
                      border: '1px solid #4338ca',
                      borderRadius: 2, padding: '1px 5px',
                      fontWeight: 700, letterSpacing: '0.03em',
                    }}>
                      LLM
                    </span>
                  )}
                </div>
              </div>
              <button
                disabled={isBusy}
                onClick={() => act(c.id, () => window.api.candidates.promote(c.id))}
                style={{
                  background: '#14532d', border: '1px solid #22c55e', borderRadius: 3,
                  padding: '4px 10px', fontSize: 11, cursor: isBusy ? 'wait' : 'pointer',
                  color: '#bbf7d0', opacity: isBusy ? 0.5 : 1,
                }}
              >
                Promote
              </button>
              <button
                disabled={isBusy}
                onClick={() => act(c.id, () => window.api.candidates.reject(c.id))}
                style={{
                  background: 'transparent', border: '1px solid #374151', borderRadius: 3,
                  padding: '4px 10px', fontSize: 11, cursor: isBusy ? 'wait' : 'pointer',
                  color: '#9ca3af', opacity: isBusy ? 0.5 : 1,
                }}
              >
                Reject
              </button>
            </div>

            {!isOpen && topQuote && (
              <div style={{ marginLeft: 64, marginTop: 4, fontSize: 11, color: '#6b7280', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                "{c.context_snippet || topQuote}"
              </div>
            )}

            {isOpen && (
              <div style={{ marginLeft: 64, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                  {[
                    ['type', c.typography_score],
                    ['signal', c.signal_score],
                    ['quality', c.quality_score],
                    ['context', c.context_score],
                  ].map(([label, value]) => (
                    <span key={label as string} style={{
                      fontSize: 10, color: '#9ca3af',
                      border: '1px solid #1f2937', borderRadius: 3, padding: '2px 6px',
                      background: '#080812',
                    }}>
                      {label}: {typeof value === 'number' ? value.toFixed(2) : '0.00'}
                    </span>
                  ))}
                </div>
                {c.context_snippet && (
                  <div style={{
                    fontSize: 11, color: '#cbd5e1', lineHeight: 1.5,
                    border: '1px solid #1f2937', borderRadius: 4,
                    background: '#0b1020', padding: '8px 10px',
                  }}>
                    <span style={{ color: '#64748b', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 6 }}>context</span>
                    {c.context_snippet}
                  </div>
                )}
                {(() => {
                  // Hide evidence quotes that are tautological with the term itself
                  // (heading evidence usually IS the term repeated — no signal).
                  const normTerm = c.term.trim().toLowerCase().replace(/^\d+(?:\.\d+)*\.?\s*/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                  const meaningful = c.evidence.filter(e => {
                    const q = (e.quote ?? '').trim().toLowerCase().replace(/^\d+(?:\.\d+)*\.?\s*/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                    return q.length > 0 && q !== normTerm;
                  });
                  return meaningful.map((e, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
                      <span style={{
                        display: 'inline-block', minWidth: 72, color: SIGNAL_COLOR[e.source] ?? '#6b7280',
                        fontWeight: 600, fontSize: 10,
                      }}>
                        {e.source}{e.pattern ? `:${e.pattern}` : ''}
                      </span>
                      <span style={{ color: '#4b5563', marginRight: 6 }}>p.{e.page}</span>
                      <span style={{ fontStyle: 'italic' }}>"{e.quote}"</span>
                    </div>
                  ));
                })()}
                {attachedEqs.length > 0 && (
                  <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px dashed #1f2937' }}>
                    <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600, marginBottom: 4 }}>
                      EQUATIONS ({attachedEqs.length})
                    </div>
                    {attachedEqs.map(eq => (
                      <EquationRow key={eq.id} eq={eq} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

const RELATION_KINDS = ['requires', 'causes', 'enables', 'contrasts_with', 'example_of'];

export function RelationsPanel({ relations, knownTerms, onCreate, onUpdate, onDelete }: {
  relations: RelationCandidate[];
  knownTerms: Set<string>;
  onCreate: (input: { from: string; to: string; kind: string; quote?: string; page?: number }) => Promise<void>;
  onUpdate: (id: number, input: { from: string; to: string; kind: string; quote?: string; page?: number }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ from: '', to: '', kind: 'requires', quote: '', page: '' });
  function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
  }
  async function saveNew(): Promise<void> {
    setBusyId('new'); setErr(null);
    try {
      await onCreate({ ...draft, page: Number(draft.page) || 0 });
      setDraft({ from: '', to: '', kind: 'requires', quote: '', page: '' });
      setAdding(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }
  return (
    <>
      <CrudHeader title="Relations" adding={adding} setAdding={setAdding} />
      {adding && (
        <RelationEditor
          draft={draft}
          setDraft={setDraft}
          busy={busyId === 'new'}
          onSave={() => void saveNew()}
          onCancel={() => setAdding(false)}
        />
      )}
      {err && <ErrorLine message={err} />}
      {relations.length === 0 && !adding && (
        <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No relation candidates.</div>
      )}
      {relations.map(r => {
        const fromKnown = knownTerms.has(norm(r.from));
        const toKnown = knownTerms.has(norm(r.to));
        const color = RELATION_COLOR[r.kind] ?? '#6b7280';
        return (
          <RelationRow
            key={r.id}
            relation={r}
            fromKnown={fromKnown}
            toKnown={toKnown}
            color={color}
            busy={busyId === r.id}
            setBusy={setBusyId}
            setErr={setErr}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        );
      })}
    </>
  );
}

function RelationRow({ relation: r, fromKnown, toKnown, color, busy, setBusy, setErr, onUpdate, onDelete }: {
  relation: RelationCandidate;
  fromKnown: boolean;
  toKnown: boolean;
  color: string;
  busy: boolean;
  setBusy: (id: number | 'new' | null) => void;
  setErr: (msg: string | null) => void;
  onUpdate: (id: number, input: { from: string; to: string; kind: string; quote?: string; page?: number }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ from: r.from, to: r.to, kind: r.kind, quote: r.quote, page: String(r.page) });
  async function save(): Promise<void> {
    setBusy(r.id); setErr(null);
    try {
      await onUpdate(r.id, { ...draft, page: Number(draft.page) || 0 });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove(): Promise<void> {
    setBusy(r.id); setErr(null);
    try {
      await onDelete(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  if (editing) {
    return <RelationEditor draft={draft} setDraft={setDraft} busy={busy} onSave={() => void save()} onCancel={() => setEditing(false)} />;
  }
  return (
    <div style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Term name={r.from} known={fromKnown} />
        <span style={{
          fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase',
          border: `1px solid ${color}`, borderRadius: 2, padding: '1px 6px',
        }}>
          {r.kind.replace(/_/g, ' ')}
        </span>
        <Term name={r.to} known={toKnown} />
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4b5563' }}>p.{r.page}</span>
        <RowButton label="Edit" disabled={busy} onClick={() => setEditing(true)} />
        <RowButton label="Delete" danger disabled={busy} onClick={() => void remove()} />
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic', lineHeight: 1.5 }}>
        "{r.quote}"
      </div>
    </div>
  );
}

function RelationEditor({ draft, setDraft, busy, onSave, onCancel }: {
  draft: { from: string; to: string; kind: string; quote: string; page: string };
  setDraft: (draft: { from: string; to: string; kind: string; quote: string; page: string }) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={editorStyle}>
      <input value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} placeholder="from concept" style={inputStyle} />
      <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })} style={inputStyle}>
        {RELATION_KINDS.map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
      </select>
      <input value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} placeholder="to concept" style={inputStyle} />
      <input value={draft.page} onChange={e => setDraft({ ...draft, page: e.target.value })} placeholder="page" style={{ ...inputStyle, width: 70, flex: '0 0 70px' }} />
      <input value={draft.quote} onChange={e => setDraft({ ...draft, quote: e.target.value })} placeholder="evidence quote" style={{ ...inputStyle, flexBasis: '100%' }} />
      <RowButton label={busy ? 'Saving...' : 'Save'} disabled={busy} onClick={onSave} />
      <RowButton label="Cancel" disabled={busy} onClick={onCancel} />
    </div>
  );
}

function Term({ name, known }: { name: string; known: boolean }) {
  return (
    <span style={{
      fontSize: 13, color: known ? '#e2e8f0' : '#6b7280',
      fontWeight: 500,
      borderBottom: known ? '1px solid #312e81' : '1px dashed #1f2937',
      paddingBottom: 1,
    }}>
      {name}
    </span>
  );
}

export function MisconceptionsPanel({ misconceptions, onCreate, onUpdate, onDelete }: {
  misconceptions: MisconceptionCandidate[];
  onCreate: (input: { quote: string; page?: number; section_path?: string[] }) => Promise<void>;
  onUpdate: (id: number, input: { quote: string; page?: number; section_path?: string[] }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ quote: '', page: '', section_path: '' });
  async function saveNew(): Promise<void> {
    setBusyId('new'); setErr(null);
    try {
      await onCreate({ quote: draft.quote, page: Number(draft.page) || 0, section_path: splitList(draft.section_path, '>') });
      setDraft({ quote: '', page: '', section_path: '' });
      setAdding(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }
  return (
    <>
      <CrudHeader title="Misconceptions" adding={adding} setAdding={setAdding} />
      {adding && (
        <MisconceptionEditor
          draft={draft}
          setDraft={setDraft}
          busy={busyId === 'new'}
          onSave={() => void saveNew()}
          onCancel={() => setAdding(false)}
        />
      )}
      {err && <ErrorLine message={err} />}
      {misconceptions.length === 0 && !adding && (
        <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No misconception phrases detected.</div>
      )}
      {misconceptions.map(m => (
        <MisconceptionRow
          key={m.id}
          item={m}
          busy={busyId === m.id}
          setBusy={setBusyId}
          setErr={setErr}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function MisconceptionRow({ item: m, busy, setBusy, setErr, onUpdate, onDelete }: {
  item: MisconceptionCandidate;
  busy: boolean;
  setBusy: (id: number | 'new' | null) => void;
  setErr: (msg: string | null) => void;
  onUpdate: (id: number, input: { quote: string; page?: number; section_path?: string[] }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ quote: m.quote, page: String(m.page), section_path: m.section_path.join(' > ') });
  async function save(): Promise<void> {
    setBusy(m.id); setErr(null);
    try {
      await onUpdate(m.id, { quote: draft.quote, page: Number(draft.page) || 0, section_path: splitList(draft.section_path, '>') });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove(): Promise<void> {
    setBusy(m.id); setErr(null);
    try {
      await onDelete(m.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  if (editing) {
    return <MisconceptionEditor draft={draft} setDraft={setDraft} busy={busy} onSave={() => void save()} onCancel={() => setEditing(false)} />;
  }
  return (
    <div style={{ borderBottom: '1px solid #111827', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, color: '#fca5a5', border: '1px solid #7f1d1d',
          borderRadius: 2, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          misconception phrase
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4b5563' }}>p.{m.page}</span>
        <RowButton label="Edit" disabled={busy} onClick={() => setEditing(true)} />
        <RowButton label="Delete" danger disabled={busy} onClick={() => void remove()} />
      </div>
      <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.6, fontStyle: 'italic' }}>
        "{m.quote}"
      </div>
      {m.section_path.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#4b5563' }}>
          {m.section_path.join(' > ')}
        </div>
      )}
    </div>
  );
}

function MisconceptionEditor({ draft, setDraft, busy, onSave, onCancel }: {
  draft: { quote: string; page: string; section_path: string };
  setDraft: (draft: { quote: string; page: string; section_path: string }) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={editorStyle}>
      <input value={draft.quote} onChange={e => setDraft({ ...draft, quote: e.target.value })} placeholder="misconception phrase" style={{ ...inputStyle, flexBasis: '100%' }} />
      <input value={draft.page} onChange={e => setDraft({ ...draft, page: e.target.value })} placeholder="page" style={{ ...inputStyle, width: 80, flex: '0 0 80px' }} />
      <input value={draft.section_path} onChange={e => setDraft({ ...draft, section_path: e.target.value })} placeholder="section > subsection" style={inputStyle} />
      <RowButton label={busy ? 'Saving...' : 'Save'} disabled={busy} onClick={onSave} />
      <RowButton label="Cancel" disabled={busy} onClick={onCancel} />
    </div>
  );
}

export function EquationsPanel({ equations, unattached, byTerm, onCreate, onUpdate, onDelete }: {
  equations: EquationCandidate[];
  unattached: EquationCandidate[];
  byTerm: Map<string, EquationCandidate[]>;
  onCreate: (input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) => Promise<void>;
  onUpdate: (id: number, input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ latex: '', page: '', variables: '', attached_term: '', section_path: '' });
  async function saveNew(): Promise<void> {
    setBusyId('new'); setErr(null);
    try {
      await onCreate({
        latex: draft.latex,
        page: Number(draft.page) || 0,
        variables: splitList(draft.variables, ','),
        attached_term: draft.attached_term.trim() || null,
        section_path: splitList(draft.section_path, '>'),
      });
      setDraft({ latex: '', page: '', variables: '', attached_term: '', section_path: '' });
      setAdding(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }
  const attached = [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <>
      <CrudHeader title="Equations" adding={adding} setAdding={setAdding} />
      {adding && (
        <EquationEditor
          draft={draft}
          setDraft={setDraft}
          busy={busyId === 'new'}
          onSave={() => void saveNew()}
          onCancel={() => setAdding(false)}
        />
      )}
      {err && <ErrorLine message={err} />}
      {equations.length === 0 && !adding && (
        <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No equation candidates.</div>
      )}
      {attached.map(([term, eqs]) => (
        <div key={term} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#c7d2fe', marginBottom: 6 }}>
            {equationGroupLabel(term, eqs)}
            <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 10 }}> * {eqs.length} equation{eqs.length === 1 ? '' : 's'}</span>
          </div>
          {eqs.map(eq => (
            <EquationRow key={eq.id} eq={eq} busy={busyId === eq.id} setBusy={setBusyId} setErr={setErr} onUpdate={onUpdate} onDelete={onDelete} />
          ))}
        </div>
      ))}
      {unattached.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Unattached ({unattached.length})
          </div>
          {unattached.map(eq => <EquationRow key={eq.id} eq={eq} busy={busyId === eq.id} setBusy={setBusyId} setErr={setErr} onUpdate={onUpdate} onDelete={onDelete} />)}
        </div>
      )}
    </>
  );
}

function EquationRow({ eq, busy, setBusy, setErr, onUpdate, onDelete }: {
  eq: EquationCandidate;
  busy?: boolean;
  setBusy?: (id: number | 'new' | null) => void;
  setErr?: (msg: string | null) => void;
  onUpdate?: (id: number, input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) => Promise<void>;
  onDelete?: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    latex: eq.latex,
    page: String(eq.page),
    variables: eq.variables.join(', '),
    attached_term: eq.attached_term ?? '',
    section_path: eq.section_path.join(' > '),
  });
  async function save(): Promise<void> {
    if (!onUpdate || !setBusy || !setErr) return;
    setBusy(eq.id); setErr(null);
    try {
      await onUpdate(eq.id, {
        latex: draft.latex,
        page: Number(draft.page) || 0,
        variables: splitList(draft.variables, ','),
        attached_term: draft.attached_term.trim() || null,
        section_path: splitList(draft.section_path, '>'),
      });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove(): Promise<void> {
    if (!onDelete || !setBusy || !setErr) return;
    setBusy(eq.id); setErr(null);
    try {
      await onDelete(eq.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  if (editing) {
    return <EquationEditor draft={draft} setDraft={setDraft} busy={!!busy} onSave={() => void save()} onCancel={() => setEditing(false)} />;
  }
  return (
    <div style={{ fontSize: 11, color: '#d1d5db', lineHeight: 1.6, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ color: '#4b5563', fontSize: 10 }}>p.{eq.page}</span>
      <span style={{
        background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 3,
        padding: '3px 7px', minWidth: 0,
      }}>
        <LatexMath value={eq.latex} size={12} />
      </span>
      {eq.variables.length > 0 && (
        <span style={{ fontSize: 10, color: '#6b7280' }}>
          vars: {eq.variables.slice(0, 6).join(', ')}
        </span>
      )}
      {onUpdate && <RowButton label="Edit" disabled={!!busy} onClick={() => setEditing(true)} />}
      {onDelete && <RowButton label="Delete" danger disabled={!!busy} onClick={() => void remove()} />}
    </div>
  );
}

function EquationEditor({ draft, setDraft, busy, onSave, onCancel }: {
  draft: { latex: string; page: string; variables: string; attached_term: string; section_path: string };
  setDraft: (draft: { latex: string; page: string; variables: string; attached_term: string; section_path: string }) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={editorStyle}>
      <input value={draft.latex} onChange={e => setDraft({ ...draft, latex: e.target.value })} placeholder="equation / latex" style={{ ...inputStyle, flexBasis: '100%' }} />
      <input value={draft.attached_term} onChange={e => setDraft({ ...draft, attached_term: e.target.value })} placeholder="attached concept / section" style={inputStyle} />
      <input value={draft.page} onChange={e => setDraft({ ...draft, page: e.target.value })} placeholder="page" style={{ ...inputStyle, width: 80, flex: '0 0 80px' }} />
      <input value={draft.variables} onChange={e => setDraft({ ...draft, variables: e.target.value })} placeholder="vars: x, y" style={inputStyle} />
      <input value={draft.section_path} onChange={e => setDraft({ ...draft, section_path: e.target.value })} placeholder="section > subsection" style={inputStyle} />
      <RowButton label={busy ? 'Saving...' : 'Save'} disabled={busy} onClick={onSave} />
      <RowButton label="Cancel" disabled={busy} onClick={onCancel} />
    </div>
  );
}

function CrudHeader({ title, adding, setAdding }: { title: string; adding: boolean; setAdding: (v: boolean) => void }) {
  return (
    <div style={{ padding: '8px 16px', borderBottom: '1px solid #111827', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>{title}</span>
      <button
        onClick={() => setAdding(!adding)}
        style={{
          marginLeft: 'auto', background: adding ? '#1f2937' : '#1e1b4b',
          border: `1px solid ${adding ? '#374151' : '#6366f1'}`, borderRadius: 3,
          color: adding ? '#cbd5e1' : '#c7d2fe', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
        }}
      >
        {adding ? 'Cancel' : '+ Add'}
      </button>
    </div>
  );
}

function RowButton({ label, onClick, disabled, danger }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: `1px solid ${danger ? '#7f1d1d' : '#374151'}`,
        borderRadius: 3,
        color: danger ? '#fca5a5' : '#9ca3af',
        fontSize: 10,
        padding: '2px 7px',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function ErrorLine({ message }: { message: string }) {
  return <div style={{ padding: '8px 16px', color: '#fca5a5', fontSize: 11, borderBottom: '1px solid #111827' }}>{message}</div>;
}

const editorStyle: React.CSSProperties = {
  borderBottom: '1px solid #111827',
  padding: '10px 16px',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(8, 8, 18, 0.8)',
};

const inputStyle: React.CSSProperties = {
  flex: '1 1 160px',
  minWidth: 0,
  background: '#080812',
  border: '1px solid #1f2937',
  borderRadius: 3,
  color: '#dbeafe',
  fontSize: 11,
  padding: '5px 7px',
  outline: 'none',
};

function splitList(value: string, separator: ',' | '>'): string[] {
  return value
    .split(separator)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
}

function equationGroupLabel(term: string, eqs: EquationCandidate[]): string {
  const pathLabels = eqs
    .flatMap(eq => eq.section_path.slice().reverse())
    .map(s => s.trim())
    .filter(Boolean);
  const matchingPath = pathLabels.find(s => normalizeLabel(s) === term);
  if (matchingPath) return matchingPath;
  return pathLabels[0] ?? term;
}
