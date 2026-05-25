import React, { useEffect, useState } from 'react';

export type Concept = {
  id: number;
  name: string;
  importance: string;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string | string[];
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

export default function ConceptPane({ sourceId, selectedId, onSelect }: Props) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [filter, setFilter] = useState('all');
  const [masteries, setMasteries] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    setConcepts([]);
    setMasteries(new Map());
    window.api.concepts.bySource(sourceId).then(r => setConcepts(r as Concept[]));
  }, [sourceId]);

  useEffect(() => {
    if (concepts.length === 0) return;
    Promise.all(
      concepts.map(c =>
        window.api.concepts.mastery(c.id).then(m => [c.id, (m as { compression_stage: number } | null)?.compression_stage ?? 0] as [number, number])
      )
    ).then(entries => setMasteries(new Map(entries)));
  }, [concepts]);

  const displayed = filter === 'all' ? concepts : concepts.filter(c => c.importance === filter);
  const masteredCount = [...masteries.values()].filter(s => s >= 3).length;

  return (
    <aside style={{ width: 260, borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Concepts ({concepts.length})
        </span>
        {concepts.length > 0 && (
          <span style={{ fontSize: 10, color: '#22c55e' }}>{masteredCount} connected+</span>
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
            {concepts.length === 0 ? 'Extract concepts to begin.' : 'No concepts in this filter.'}
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
