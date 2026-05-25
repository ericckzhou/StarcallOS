import React, { useCallback, useEffect, useState } from 'react';
import type { Concept } from './ConceptPane';

interface QueueItem {
  concept: {
    id: number;
    name: string;
    importance: string;
    definition_text: string;
    section_path: string[];
  };
  source_title: string | null;
  source_filename: string;
  compression_stage: number;
  last_reviewed_at: string | null;
  attempts: number;
}

const STAGE_COLORS = ['#374151', '#6b7280', '#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e'];
const STAGES = ['Unseen', 'Memorized', 'Can Explain', 'Connected', 'Compressed', 'Predicts Failures'];
const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};
const COLLAPSED_KEY = 'starcall.layout.reviewQueueCollapsed';
const WIDTH_KEY = 'starcall.layout.reviewQueueWidth';

interface Props {
  onSelect: (concept: Concept) => void;
  selectedConcept: Concept | null;
}

export default function ReviewQueue({ onSelect, selectedConcept }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 420);

  const refresh = useCallback(() => {
    setLoading(true);
    window.api.review.queue(50).then(r => {
      setItems(r as QueueItem[]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  function beginResize(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.max(280, Math.min(680, startWidth + moveEvent.clientX - startX));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  if (loading) {
    return (
      <aside style={{ width, borderRight: '1px solid #1f2937', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', fontSize: 13 }}>
        Loading review queue...
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside style={{
        width: 36, borderRight: '1px solid #1f2937', background: '#0d0d16',
        display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8,
      }}>
        <button
          onClick={() => setCollapsed(false)}
          title={`Review queue (${items.length}) - click to expand`}
          style={{
            background: 'transparent', border: '1px solid #1f2937', borderRadius: 3,
            color: selectedConcept ? '#c7d2fe' : '#9ca3af', fontSize: 12, padding: '4px 6px', cursor: 'pointer',
            writingMode: 'vertical-rl', textOrientation: 'mixed', maxHeight: 190,
          }}
        >
          {selectedConcept?.name ?? `Review (${items.length})`}
        </button>
      </aside>
    );
  }

  if (items.length === 0) {
    return (
      <aside style={{ width, borderRight: '1px solid #1f2937', padding: 40, boxSizing: 'border-box', textAlign: 'center', color: '#374151', fontSize: 13, lineHeight: 1.6 }}>
        Nothing to review. Promote candidates or extract more sources to populate the queue.
      </aside>
    );
  }

  return (
    <aside style={{ width, flexShrink: 0, borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      <div
        onMouseDown={beginResize}
        title="Drag to resize review queue"
        style={{
          position: 'absolute', top: 0, right: -4, width: 8, height: '100%',
          cursor: 'col-resize', zIndex: 5,
        }}
      />
      <div style={{
        padding: '9px 14px', borderBottom: '1px solid #1f2937',
        display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>
            Review Queue <span style={{ color: '#94a3b8' }}>{items.length}</span>
          </div>
          <div style={{ marginTop: 2, fontSize: 10, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {items.filter(i => i.last_reviewed_at == null).length} never reviewed · {items.filter(i => i.compression_stage >= 1 && i.compression_stage < 3).length} mid-stage
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => setCollapsed(true)}
            title="Minimize review queue"
            aria-label="Minimize review queue"
            style={{
              width: 24, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: '#111827', border: '1px solid #263244', borderRadius: 4,
              padding: 0, fontSize: 13, lineHeight: 1, cursor: 'pointer', color: '#94a3b8',
            }}
          >
            ‹
          </button>
          <button
            onClick={refresh}
            style={{
              background: 'transparent', border: '1px solid #263244', borderRadius: 4,
              padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: '#94a3b8',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.map(it => {
          const c = it.concept;
          const stage = it.compression_stage;
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c as unknown as Concept)}
              style={{
                padding: '12px 20px', borderBottom: '1px solid #111827', cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: STAGE_COLORS[stage], flexShrink: 0 }} />
                <div style={{ fontSize: 14, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </div>
                <span style={{ fontSize: 10, color: IMP_COLOR[c.importance] ?? '#6b7280', marginLeft: 'auto' }}>
                  {c.importance}
                </span>
                <span style={{ fontSize: 10, color: STAGE_COLORS[stage] }}>
                  {STAGES[stage]}
                </span>
              </div>
              <div style={{ paddingLeft: 18, display: 'flex', gap: 12, fontSize: 11, color: '#6b7280' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
                  {it.source_title || it.source_filename}
                </span>
                {it.attempts > 0 ? (
                  <span>{it.attempts} attempt{it.attempts === 1 ? '' : 's'}</span>
                ) : (
                  <span style={{ color: '#f59e0b' }}>never reviewed</span>
                )}
                {c.section_path?.length > 0 && (
                  <span style={{ color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
                    {c.section_path.join(' > ')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
