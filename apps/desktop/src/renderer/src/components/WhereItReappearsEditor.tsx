import React, { useEffect, useRef, useState } from 'react';

interface Hit {
  id: number;
  name: string;
  importance: string;
  source_filename?: string;
}

interface Props {
  conceptId: number;
  value: string[];
  onChange: (next: string[]) => void;
}

const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};

// Typeahead concept linker. Suggests other promoted concepts on the same
// source whose name starts with the typed prefix; selecting one appends it
// as a chip. Free-text typing without selection is intentionally not a
// commit path — we want every entry to refer to a real concept on this
// source. Legacy free-text values from before this component still render
// as removable chips so nothing is silently lost.
export default function WhereItReappearsEditor({ conceptId, value, onChange }: Props) {
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const queryIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const prefix = input.trim();
    if (prefix.length === 0) {
      setHits([]);
      setOpen(false);
      return;
    }
    const myQueryId = ++queryIdRef.current;
    debounceRef.current = setTimeout(() => {
      window.api.concepts.searchByPrefix({ conceptId, prefix, limit: 8 }).then(rows => {
        // Discard if a newer query has been issued since.
        if (myQueryId !== queryIdRef.current) return;
        const selected = new Set(value.map(v => v.toLowerCase()));
        const filtered = (rows as Hit[]).filter(h => !selected.has(h.name.toLowerCase()));
        setHits(filtered);
        setActiveIdx(0);
        setOpen(filtered.length > 0);
      });
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input, conceptId, value]);

  function addHit(h: Hit) {
    onChange([...value, h.name]);
    setInput('');
    setHits([]);
    setOpen(false);
  }

  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  function addBestHit() {
    if (hits.length === 0) return;
    const exact = hits.find(h => h.name.toLowerCase() === input.trim().toLowerCase());
    addHit(exact ?? hits[0]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); addHit(hits[activeIdx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {value.map((w, i) => (
            <span
              key={`${w}-${i}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 12, padding: '3px 8px 3px 10px', borderRadius: 12,
                background: '#1e1b4b', border: '1px solid #312e81', color: '#c7d2fe',
              }}
            >
              {w}
              <button
                onClick={() => removeAt(i)}
                title={`Remove "${w}"`}
                style={{
                  background: 'transparent', border: 'none', color: '#a5b4fc',
                  fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: 0,
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}

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
              width: '100%',
              background: '#0d0d16',
              border: '1px solid #1f2937',
              borderRadius: 4,
              padding: '6px 10px',
              color: '#e2e8f0',
              fontSize: 12,
              outline: 'none',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            disabled={hits.length === 0}
            onMouseDown={e => e.preventDefault()}
            onClick={addBestHit}
            title={hits.length > 0 ? `Add ${hits[0].name}` : 'Type a matching concept name first'}
            style={{
              background: hits.length > 0 ? '#1e1b4b' : 'transparent',
              border: hits.length > 0 ? '1px solid #6366f1' : '1px solid #1f2937',
              borderRadius: 4,
              color: hits.length > 0 ? '#c7d2fe' : '#475569',
              cursor: hits.length > 0 ? 'pointer' : 'not-allowed',
              fontSize: 11,
              fontWeight: 700,
              padding: '0 10px',
              whiteSpace: 'nowrap',
            }}
          >
            + Add
          </button>
        </div>
        {open && hits.length > 0 && (
          <div
            role="listbox"
            style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 10,
              background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 4,
              maxHeight: 240, overflowY: 'auto',
              boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
            }}
          >
            {hits.map((h, i) => (
              <button
                key={h.id}
                role="option"
                aria-selected={i === activeIdx}
                onMouseDown={e => e.preventDefault()}
                onClick={() => addHit(h)}
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
    </div>
  );
}
