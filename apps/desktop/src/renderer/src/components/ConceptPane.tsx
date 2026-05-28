import React, { useEffect, useRef, useState } from 'react';

export type Concept = {
  id: number;
  source_id?: number;
  name: string;
  importance: string;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string | string[];
  section_path?: string[];
};

interface Props {
  sourceId: number;
  selectedId: number | null;
  onSelect: (concept: Concept) => void;
}

const IMPORTANCE_ORDER = ['foundational', 'core', 'supporting', 'peripheral', 'reference_only'];
const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};
const IMP_LABEL: Record<string, string> = {
  all: 'All', foundational: 'Found.', core: 'Core',
  supporting: 'Supp.', peripheral: 'Periph.', reference_only: 'Ref.',
};
const STAGE_COLORS = ['#374151', '#6b7280', '#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e'];
const COLLAPSED_KEY = 'starcall.layout.conceptsCollapsed';

export default function ConceptPane({ sourceId, selectedId, onSelect }: Props) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [masteries, setMasteries] = useState<Map<number, number>>(new Map());
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createImportance, setCreateImportance] = useState('supporting');
  const [createDefinition, setCreateDefinition] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setConcepts([]);
    setMasteries(new Map());
    setSearch('');
    window.api.concepts.bySource(sourceId).then(r => setConcepts(r as Concept[]));
  }, [sourceId]);

  // "/" focuses the concept search from anywhere in the pane (unless already
  // typing in a field); Esc clears + blurs.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (concepts.length === 0) return;
    Promise.all(
      concepts.map(c =>
        window.api.concepts.mastery(c.id).then(m => [c.id, (m as { compression_stage: number } | null)?.compression_stage ?? 0] as [number, number])
      )
    ).then(entries => setMasteries(new Map(entries)));
  }, [concepts]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const query = search.trim().toLowerCase();
  const displayed = concepts.filter(c =>
    (filter === 'all' || c.importance === filter) &&
    (query === '' || c.name.toLowerCase().includes(query)),
  );
  const masteredCount = [...masteries.values()].filter(s => s >= 3).length;
  const selectedConcept = selectedId != null ? concepts.find(c => c.id === selectedId) : null;

  async function createManualConcept(): Promise<void> {
    const name = createName.trim();
    if (!name) {
      setCreateError('Name is required.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await window.api.concepts.createManual({
        sourceId,
        name,
        importance: createImportance,
        definition_text: createDefinition,
      }) as Concept;
      setConcepts(prev => {
        const existing = prev.find(c => c.id === created.id);
        if (existing) return prev;
        return [...prev, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      setMasteries(prev => new Map(prev).set(created.id, 0));
      setCreateName('');
      setCreateDefinition('');
      setCreateImportance('supporting');
      setCreateOpen(false);
      onSelect(created);
      window.dispatchEvent(new Event('starcall:review-queue-stale'));
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  if (collapsed) {
    return (
      <aside style={{
        width: 36, borderRight: '1px solid #1f2937', background: '#0d0d16',
        display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8,
      }}>
        <button
          onClick={() => setCollapsed(false)}
          title={`Concepts (${concepts.length}) - click to expand`}
          style={{
            background: 'transparent', border: '1px solid #1f2937', borderRadius: 3,
            color: selectedConcept ? '#c7d2fe' : '#9ca3af', fontSize: 12, padding: '4px 6px', cursor: 'pointer',
            writingMode: 'vertical-rl', textOrientation: 'mixed', maxHeight: 180,
          }}
        >
          {selectedConcept?.name ?? `Concepts (${concepts.length})`}
        </button>
      </aside>
    );
  }

  return (
    <aside style={{ width: 260, borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 10px 10px 14px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Concepts ({concepts.length})
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {concepts.length > 0 && (
            <span style={{ fontSize: 10, color: '#22c55e' }}>{masteredCount} connected+</span>
          )}
          <button
            onClick={() => setCreateOpen(true)}
            title="Add your own concept to this source"
            style={{ background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 4, padding: '3px 7px', color: '#c7d2fe', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
          >
            +
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Minimize concepts"
            style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '3px 7px', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
          >
            &lt;
          </button>
        </div>
      </div>
      {createOpen && (
        <div style={{
          borderBottom: '1px solid #1f2937',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: 'rgba(13, 13, 22, 0.86)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, color: '#c7d2fe', fontWeight: 800 }}>Add concept</div>
            <button
              onClick={() => { setCreateOpen(false); setCreateError(null); }}
              disabled={createBusy}
              title="Cancel"
              style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, color: '#94a3b8', cursor: createBusy ? 'wait' : 'pointer', fontSize: 12, padding: '1px 7px' }}
            >
              x
            </button>
          </div>
          <input
            autoFocus
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void createManualConcept();
              }
            }}
            placeholder="Concept name"
            style={{
              background: '#111827', border: '1px solid #263244', borderRadius: 4,
              padding: '7px 8px', color: '#e2e8f0', fontSize: 12, outline: 'none',
            }}
          />
          <select
            value={createImportance}
            onChange={e => setCreateImportance(e.target.value)}
            style={{
              background: '#111827', border: '1px solid #263244', borderRadius: 4,
              padding: '6px 8px', color: '#cbd5e1', fontSize: 12, outline: 'none',
            }}
          >
            {IMPORTANCE_ORDER.map(imp => (
              <option key={imp} value={imp}>{imp}</option>
            ))}
          </select>
          <textarea
            value={createDefinition}
            onChange={e => setCreateDefinition(e.target.value)}
            placeholder="Optional starter definition..."
            rows={3}
            style={{
              background: '#111827', border: '1px solid #263244', borderRadius: 4,
              padding: '7px 8px', color: '#cbd5e1', fontSize: 12, lineHeight: 1.5,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }}
          />
          {createError && <div style={{ fontSize: 11, color: '#fca5a5' }}>{createError}</div>}
          <button
            onClick={() => void createManualConcept()}
            disabled={createBusy}
            style={{
              background: createBusy ? '#111827' : '#312e81',
              border: '1px solid #6366f1',
              borderRadius: 4,
              padding: '7px 10px',
              color: createBusy ? '#64748b' : '#e0e7ff',
              fontSize: 12,
              fontWeight: 800,
              cursor: createBusy ? 'wait' : 'pointer',
            }}
          >
            {createBusy ? 'Creating...' : 'Create and open'}
          </button>
        </div>
      )}
      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid #1f2937', position: 'relative' }}>
        <input
          ref={searchRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setSearch('');
              searchRef.current?.blur();
            }
          }}
          placeholder="Search concepts…  ( / )"
          style={{
            width: '100%', boxSizing: 'border-box',
            background: '#111827', border: '1px solid #263244', borderRadius: 4,
            padding: '6px 26px 6px 8px', color: '#e2e8f0', fontSize: 12, outline: 'none',
          }}
        />
        {search && (
          <button
            onClick={() => { setSearch(''); searchRef.current?.focus(); }}
            title="Clear search"
            style={{
              position: 'absolute', right: 16, top: 13,
              background: 'transparent', border: 'none', color: '#6b7280',
              fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: 0,
            }}
          >×</button>
        )}
      </div>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #1f2937', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {['all', ...IMPORTANCE_ORDER].map(imp => (
          <button
            key={imp}
            onClick={() => setFilter(imp)}
            style={{
              background: filter === imp ? '#1e1e2e' : 'transparent',
              border: `1px solid ${filter === imp ? (IMP_COLOR[imp] ?? '#818cf8') : '#1f2937'}`,
              borderRadius: 3, padding: '2px 6px', fontSize: 10, cursor: 'pointer',
              color: filter === imp ? (IMP_COLOR[imp] ?? '#818cf8') : '#4b5563',
            }}
          >
            {IMP_LABEL[imp]}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {displayed.length === 0 && (
          <div style={{ padding: 20, color: '#374151', fontSize: 12, textAlign: 'center' }}>
            {concepts.length === 0
              ? 'Extract concepts to begin.'
              : query
                ? 'No concepts match your search.'
                : 'No concepts in this filter.'}
          </div>
        )}
        {displayed.map(c => {
          const stage = masteries.get(c.id) ?? 0;
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c)}
              style={{
                padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #111827',
                background: selectedId === c.id ? '#1a1a2e' : 'transparent',
                borderLeft: `2px solid ${selectedId === c.id ? (IMP_COLOR[c.importance] ?? '#374151') : 'transparent'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: STAGE_COLORS[stage], flexShrink: 0 }} />
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
              </div>
              <div style={{ paddingLeft: 15, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, color: IMP_COLOR[c.importance] ?? '#6b7280' }}>{c.importance}</span>
                {stage > 0 && <span style={{ fontSize: 10, color: STAGE_COLORS[stage] }}>Stage {stage}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
