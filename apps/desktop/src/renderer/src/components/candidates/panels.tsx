import React from 'react';
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
                fontSize: 12, color: confColor(c.confidence), fontWeight: 600,
              }}>
                {c.confidence.toFixed(2)}
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
                "{topQuote}"
              </div>
            )}

            {isOpen && (
              <div style={{ marginLeft: 64, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
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

export function RelationsPanel({ relations, knownTerms }: { relations: RelationCandidate[]; knownTerms: Set<string> }) {
  if (relations.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No relation candidates.</div>;
  }
  function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
  }
  return (
    <>
      {relations.map(r => {
        const fromKnown = knownTerms.has(norm(r.from));
        const toKnown = knownTerms.has(norm(r.to));
        const color = RELATION_COLOR[r.kind] ?? '#6b7280';
        return (
          <div key={r.id} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
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
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic', lineHeight: 1.5 }}>
              "{r.quote}"
            </div>
          </div>
        );
      })}
    </>
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

export function MisconceptionsPanel({ misconceptions }: { misconceptions: MisconceptionCandidate[] }) {
  if (misconceptions.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No misconception phrases detected.</div>;
  }
  return (
    <>
      {misconceptions.map(m => (
        <div key={m.id} style={{ borderBottom: '1px solid #111827', padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 9, color: '#fca5a5', border: '1px solid #7f1d1d',
              borderRadius: 2, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              misconception phrase
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4b5563' }}>p.{m.page}</span>
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
      ))}
    </>
  );
}

export function EquationsPanel({ equations, unattached, byTerm }: {
  equations: EquationCandidate[];
  unattached: EquationCandidate[];
  byTerm: Map<string, EquationCandidate[]>;
}) {
  if (equations.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No equation candidates.</div>;
  }
  const attached = [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <>
      {attached.map(([term, eqs]) => (
        <div key={term} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#c7d2fe', marginBottom: 6 }}>
            {term} <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 10 }}>* {eqs.length} equation{eqs.length === 1 ? '' : 's'}</span>
          </div>
          {eqs.map(eq => (
            <EquationRow key={eq.id} eq={eq} />
          ))}
        </div>
      ))}
      {unattached.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Unattached ({unattached.length})
          </div>
          {unattached.map(eq => <EquationRow key={eq.id} eq={eq} />)}
        </div>
      )}
    </>
  );
}

function EquationRow({ eq }: { eq: EquationCandidate }) {
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
    </div>
  );
}
