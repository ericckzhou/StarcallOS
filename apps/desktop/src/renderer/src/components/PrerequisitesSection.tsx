import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConceptPrerequisites, PrerequisiteNode, PrerequisiteSuggestion } from '@starcall/shared';

interface Props {
  conceptId: number;
  sourceId: number;
  conceptName: string;
}

interface Hit {
  id: number;
  name: string;
  importance: string;
  source_filename?: string;
}

// Mastery stage → ring color (mirrors the Map's orange→green ramp). Stages
// below PREREQUISITE_READY (2) read as "not yet known".
function stageColor(stage: number): string {
  if (stage >= 4) return '#34d399';
  if (stage >= 3) return '#a3e635';
  if (stage >= 2) return '#fbbf24';
  if (stage >= 1) return '#f59e0b';
  return '#6b7280';
}

const EMPTY: ConceptPrerequisites = { direct: [], learnFirst: [], unlocks: [], blocked: [], hasCycle: false };

// Prerequisite / dependency curation for one concept. Reads the computed
// learn-first / unlocks traversal, lets the user manually add or remove
// prerequisite edges (user-curated), and surfaces deterministic suggestions
// to accept/reject. Edges only exist once the user creates/accepts them.
export default function PrerequisitesSection({ conceptId, sourceId, conceptName }: Props) {
  const [data, setData] = useState<ConceptPrerequisites>(EMPTY);
  const [suggestions, setSuggestions] = useState<PrerequisiteSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  // Typeahead state for "add a prerequisite".
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const queryIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [prereqs, sugs] = await Promise.all([
      window.api.concepts.prerequisites(conceptId),
      window.api.prereq.suggestions({ sourceId, status: 'pending' }),
    ]);
    setData(prereqs);
    // Only suggestions that touch THIS concept are relevant to its panel.
    setSuggestions(sugs.filter(s => s.from_id === conceptId || s.to_id === conceptId));
  }, [conceptId, sourceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Re-pull when the graph changes elsewhere (e.g. another pane accepts an edge).
  useEffect(() => {
    const handler = () => { void refresh(); };
    window.addEventListener('starcall:graphChanged', handler);
    return () => window.removeEventListener('starcall:graphChanged', handler);
  }, [refresh]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const prefix = input.trim();
    if (prefix.length === 0) { setHits([]); setOpen(false); return; }
    const myId = ++queryIdRef.current;
    debounceRef.current = setTimeout(() => {
      window.api.concepts.searchByPrefix({ conceptId, prefix, limit: 8 }).then(rows => {
        if (myId !== queryIdRef.current) return;
        const taken = new Set(data.direct.map(d => d.id));
        const filtered = (rows as Hit[]).filter(h => !taken.has(h.id));
        setHits(filtered);
        setOpen(filtered.length > 0);
      });
    }, 120);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, conceptId, data.direct]);

  // Tell the Map + review queue the prerequisite graph moved.
  function announceChange() {
    window.dispatchEvent(new Event('starcall:graphChanged'));
    window.dispatchEvent(new Event('starcall:review-queue-stale'));
  }

  async function addPrerequisite(h: Hit) {
    setInput(''); setHits([]); setOpen(false);
    setBusy(true);
    try {
      // The picked concept is a prerequisite OF this one: from = prereq, to = this.
      await window.api.concepts.edgeCreate({ fromId: h.id, toId: conceptId, edgeType: 'requires' });
      await refresh();
      announceChange();
    } finally { setBusy(false); }
  }

  async function removePrerequisite(node: PrerequisiteNode) {
    setBusy(true);
    try {
      // We don't track which dependency kind backs a direct prereq; clear both
      // (idempotent no-ops) so removal always works.
      await window.api.concepts.edgeDelete({ fromId: node.id, toId: conceptId, edgeType: 'requires' });
      await window.api.concepts.edgeDelete({ fromId: node.id, toId: conceptId, edgeType: 'enables' });
      await refresh();
      announceChange();
    } finally { setBusy(false); }
  }

  async function scan() {
    setScanning(true);
    try {
      await window.api.prereq.compute(sourceId);
      await refresh();
    } finally { setScanning(false); }
  }

  async function acceptSuggestion(id: number) {
    setBusy(true);
    try { await window.api.prereq.accept(id); await refresh(); announceChange(); }
    finally { setBusy(false); }
  }

  async function rejectSuggestion(id: number) {
    setBusy(true);
    try { await window.api.prereq.reject(id); await refresh(); }
    finally { setBusy(false); }
  }

  const directIds = new Set(data.direct.map(d => d.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Learn first */}
      <div>
        <Label>Learn first</Label>
        {data.learnFirst.length === 0 ? (
          <Empty>No prerequisites yet. Add one below or scan the source.</Empty>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.learnFirst.map((n, i) => {
              const blocked = n.mastery_stage < 2 && directIds.has(n.id);
              return (
                <span key={n.id} title={`stage ${n.mastery_stage}${blocked ? ' — learn this first' : ''}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: blocked ? 'rgba(120, 53, 15, 0.35)' : '#1e1b4b',
                    border: `1px solid ${blocked ? '#b45309' : '#312e81'}`,
                    borderRadius: 999, padding: '3px 9px', fontSize: 11, color: '#e0e7ff',
                  }}>
                  <span style={{ fontSize: 9, color: '#94a3b8' }}>{i + 1}</span>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: stageColor(n.mastery_stage), flexShrink: 0 }} aria-hidden="true" />
                  {n.name}
                </span>
              );
            })}
          </div>
        )}
        {data.hasCycle && (
          <div style={{ marginTop: 6, fontSize: 10, color: '#fca5a5' }}>
            ⚠ A prerequisite cycle was detected — order is approximate.
          </div>
        )}
      </div>

      {/* Direct prerequisites with remove */}
      {data.direct.length > 0 && (
        <div>
          <Label>Direct prerequisites</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {data.direct.map(n => (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(17,24,39,0.4)', border: '1px solid #312e81', borderRadius: 6, padding: '5px 6px 5px 9px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: stageColor(n.mastery_stage), flexShrink: 0 }} aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#e0e7ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                <button onClick={() => removePrerequisite(n)} disabled={busy} title={`Remove "${n.name}" as a prerequisite`}
                  style={{ background: 'transparent', border: 'none', color: '#a5b4fc', fontSize: 15, lineHeight: 1, cursor: busy ? 'wait' : 'pointer', width: 22, height: 22, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add a prerequisite (typeahead) */}
      <div style={{ position: 'relative' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => { if (hits.length > 0) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder="Add a prerequisite concept…"
          disabled={busy}
          style={{ width: '100%', background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 10px', color: '#e2e8f0', fontSize: 12, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
        />
        {open && hits.length > 0 && (
          <div role="listbox" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 10, background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 4, maxHeight: 240, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.45)' }}>
            {hits.map(h => (
              <button key={h.id} role="option" onMouseDown={e => e.preventDefault()} onClick={() => addPrerequisite(h)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', textAlign: 'left', padding: '6px 10px', fontSize: 12, color: '#e2e8f0', cursor: 'pointer' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                {h.source_filename && (
                  <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: '#64748b' }}>{h.source_filename}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Suggestions */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Label inline>Suggested ({suggestions.length})</Label>
          <button onClick={scan} disabled={scanning}
            style={{ background: 'transparent', border: '1px dashed #374151', borderRadius: 4, padding: '3px 9px', color: '#a5b4fc', fontSize: 10, fontWeight: 700, cursor: scanning ? 'wait' : 'pointer' }}>
            {scanning ? 'Scanning…' : 'Scan source'}
          </button>
        </div>
        {suggestions.length === 0 ? (
          <Empty>No pending suggestions. "Scan source" derives them from the text.</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {suggestions.map(s => (
              <div key={s.id} title={s.reason || undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(30,27,75,0.5)', border: '1px solid #4338ca', borderRadius: 6, padding: '5px 6px 5px 9px' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#c7d2fe', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong>{s.from_name}</strong>
                  <span style={{ color: '#818cf8' }}> {s.edge_type === 'requires' ? '→ prerequisite of →' : '→ enables →'} </span>
                  <strong>{s.to_name}</strong>
                </span>
                <button onClick={() => acceptSuggestion(s.id)} disabled={busy} title="Accept — create this edge"
                  style={{ background: '#14532d', border: '1px solid #16a34a', borderRadius: 4, color: '#bbf7d0', fontSize: 12, lineHeight: 1, cursor: busy ? 'wait' : 'pointer', width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</button>
                <button onClick={() => rejectSuggestion(s.id)} disabled={busy} title="Dismiss this suggestion"
                  style={{ background: 'transparent', border: 'none', color: '#a5b4fc', fontSize: 15, lineHeight: 1, cursor: busy ? 'wait' : 'pointer', width: 22, height: 22, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unlocks (read-only) */}
      {data.unlocks.length > 0 && (
        <div>
          <Label>Mastering {conceptName} unlocks</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.unlocks.map(n => (
              <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(8,47,73,0.4)', border: '1px solid #0e7490', borderRadius: 999, padding: '3px 9px', fontSize: 11, color: '#a5f3fc' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: stageColor(n.mastery_stage), flexShrink: 0 }} aria-hidden="true" />
                {n.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Label({ children, inline }: { children: React.ReactNode; inline?: boolean }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: '#64748b', marginBottom: inline ? 0 : 6 }}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>{children}</div>;
}
