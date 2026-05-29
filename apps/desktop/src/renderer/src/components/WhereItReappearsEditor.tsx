import React, { useEffect, useRef, useState } from 'react';

export interface ConstellationLink {
  name: string;
  reason: string;
}

interface Hit {
  id: number;
  name: string;
  importance: string;
  source_filename?: string;
}

interface Props {
  conceptId: number;
  value: ConstellationLink[];
  onChange: (next: ConstellationLink[]) => void;
}

const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};

// Typeahead concept linker. Selecting a concept does NOT immediately add it —
// the user must first state WHY the two concepts relate; that reason is stored
// alongside the link and surfaced on the Constellation Map.
export default function WhereItReappearsEditor({ conceptId, value, onChange }: Props) {
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // A link awaiting its reason. editIndex = index in `value` being edited, or
  // null when it's a brand-new link.
  const [pending, setPending] = useState<{ name: string; reason: string; editIndex: number | null } | null>(null);
  const queryIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const prefix = input.trim();
    if (prefix.length === 0) { setHits([]); setOpen(false); return; }
    const myQueryId = ++queryIdRef.current;
    debounceRef.current = setTimeout(() => {
      window.api.concepts.searchByPrefix({ conceptId, prefix, limit: 8 }).then(rows => {
        if (myQueryId !== queryIdRef.current) return;
        const selected = new Set(value.map(v => v.name.toLowerCase()));
        const filtered = (rows as Hit[]).filter(h => !selected.has(h.name.toLowerCase()));
        setHits(filtered);
        setActiveIdx(0);
        setOpen(filtered.length > 0);
      });
    }, 120);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, conceptId, value]);

  function beginAdd(h: Hit) {
    setPending({ name: h.name, reason: '', editIndex: null });
    setInput(''); setHits([]); setOpen(false);
    setTimeout(() => reasonRef.current?.focus(), 0);
  }

  function beginEdit(i: number) {
    const link = value[i];
    setPending({ name: link.name, reason: link.reason, editIndex: i });
    setTimeout(() => reasonRef.current?.focus(), 0);
  }

  function confirmPending() {
    if (!pending) return;
    const reason = pending.reason.trim();
    if (!reason) return; // reason is required
    const link: ConstellationLink = { name: pending.name, reason };
    if (pending.editIndex == null) onChange([...value, link]);
    else onChange(value.map((l, idx) => (idx === pending.editIndex ? link : l)));
    setPending(null);
  }

  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
    if (pending?.editIndex === i) setPending(null);
  }

  function addBestHit() {
    if (hits.length === 0) return;
    const exact = hits.find(h => h.name.toLowerCase() === input.trim().toLowerCase());
    beginAdd(exact ?? hits[0]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); beginAdd(hits[activeIdx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {value.map((link, i) => (
            <div
              key={`${link.name}-${i}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                background: '#1e1b4b', border: '1px solid #312e81', borderRadius: 8,
                padding: '6px 8px 6px 11px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  onClick={() => beginEdit(i)}
                  title="Edit reason"
                  style={{ background: 'transparent', border: 'none', padding: 0, color: '#c7d2fe', fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}
                >
                  {link.name}
                </button>
                <div style={{ fontSize: 11, color: link.reason ? '#a5b4fc' : '#6b7280', lineHeight: 1.45, marginTop: 1 }}>
                  {link.reason || 'No reason yet — click the name to add one.'}
                </div>
              </div>
              <button
                onClick={() => removeAt(i)}
                title={`Remove "${link.name}"`}
                style={{ background: 'transparent', border: 'none', color: '#a5b4fc', fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: 0, flexShrink: 0 }}
              >×</button>
            </div>
          ))}
        </div>
      )}

      {pending ? (
        <div style={{
          border: '1px solid #4338ca', borderRadius: 8, padding: 10,
          background: 'rgba(13,13,22,0.86)', display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontSize: 12, color: '#c7d2fe' }}>
            Why does this relate to <span style={{ fontWeight: 800 }}>{pending.name}</span>?
          </div>
          <textarea
            ref={reasonRef}
            value={pending.reason}
            onChange={e => setPending(p => (p ? { ...p, reason: e.target.value } : p))}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirmPending(); }
              else if (e.key === 'Escape') { e.preventDefault(); setPending(null); }
            }}
            placeholder={`How does this relate to ${pending.name}? — builds on, contrasts with, depends on…`}
            rows={2}
            style={{
              background: '#111827', border: '1px solid #263244', borderRadius: 4,
              padding: '7px 9px', color: '#e2e8f0', fontSize: 12, lineHeight: 1.5,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={confirmPending}
              disabled={pending.reason.trim().length === 0}
              title={pending.reason.trim() ? '' : 'A reason is required'}
              style={{
                background: pending.reason.trim() ? '#312e81' : '#111827',
                border: `1px solid ${pending.reason.trim() ? '#6366f1' : '#1f2937'}`,
                borderRadius: 4, padding: '5px 12px',
                color: pending.reason.trim() ? '#e0e7ff' : '#475569',
                fontSize: 12, fontWeight: 700, cursor: pending.reason.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {pending.editIndex == null ? 'Link' : 'Save reason'}
            </button>
            <button
              onClick={() => setPending(null)}
              style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '5px 12px', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => { if (hits.length > 0) setOpen(true); }}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              placeholder="Type to link any concept..."
              style={{
                width: '100%', background: '#0d0d16', border: '1px solid #1f2937',
                borderRadius: 4, padding: '6px 10px', color: '#e2e8f0', fontSize: 12,
                outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
            <button
              type="button"
              disabled={hits.length === 0}
              onMouseDown={e => e.preventDefault()}
              onClick={addBestHit}
              title={hits.length > 0 ? `Link ${hits[0].name}` : 'Type a matching concept name first'}
              style={{
                background: hits.length > 0 ? '#1e1b4b' : 'transparent',
                border: hits.length > 0 ? '1px solid #6366f1' : '1px solid #1f2937',
                borderRadius: 4, color: hits.length > 0 ? '#c7d2fe' : '#475569',
                cursor: hits.length > 0 ? 'pointer' : 'not-allowed',
                fontSize: 11, fontWeight: 700, padding: '0 10px', whiteSpace: 'nowrap',
              }}
            >
              + Link
            </button>
          </div>
          {open && hits.length > 0 && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 10,
                background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 4,
                maxHeight: 240, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
              }}
            >
              {hits.map((h, i) => (
                <button
                  key={h.id}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => beginAdd(h)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    background: i === activeIdx ? '#1e1b4b' : 'transparent',
                    border: 'none', textAlign: 'left',
                    padding: '6px 10px', fontSize: 12, color: '#e2e8f0', cursor: 'pointer',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.name}
                  </span>
                  <span style={{ fontSize: 10, color: IMP_COLOR[h.importance] ?? '#6b7280' }}>
                    {h.importance}
                  </span>
                  {h.source_filename && (
                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: '#64748b' }}>
                      {h.source_filename}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
