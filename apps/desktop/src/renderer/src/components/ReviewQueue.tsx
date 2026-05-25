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

interface Props {
  onSelect: (concept: Concept) => void;
}

export default function ReviewQueue({ onSelect }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    window.api.review.queue(50).then(r => {
      setItems(r as QueueItem[]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 13 }}>Loading review queue…</div>;
  }
  if (items.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 13, lineHeight: 1.6 }}>
        Nothing to review. Promote candidates or extract more sources to populate the queue.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '10px 20px', borderBottom: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Review Queue — {items.length}
        </span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          {items.filter(i => i.last_reviewed_at == null).length} never reviewed · {items.filter(i => i.compression_stage >= 1 && i.compression_stage < 3).length} mid-stage
        </span>
        <button
          onClick={refresh}
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #1f2937', borderRadius: 3, padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: '#9ca3af' }}
        >
          Refresh
        </button>
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
                    {c.section_path.join(' › ')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
