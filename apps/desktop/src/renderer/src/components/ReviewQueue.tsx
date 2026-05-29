import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Concept } from './ConceptPane';
import { LAST_SOURCE_KEY } from '../App';

interface QueueItem {
  concept: {
    id: number;
    name: string;
    importance: string;
    definition_text: string;
    section_path: string[];
  };
  source_id: number;
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
const IMP_RANK: Record<string, number> = {
  foundational: 0, core: 1, supporting: 2, peripheral: 3, reference_only: 4,
};
const COLLAPSED_KEY = 'starcall.layout.reviewQueueCollapsed';
const GROUP_COLLAPSED_KEY = 'starcall.layout.reviewQueueCollapsedGroups';
const WIDTH_KEY = 'starcall.layout.reviewQueueWidth';
const SORT_KEY = 'starcall.layout.reviewQueueSort';

type SortMode = 'default' | 'importance' | 'stage';
const SORT_CYCLE: SortMode[] = ['default', 'importance', 'stage'];
const SORT_LABEL: Record<SortMode, string> = {
  default:    'default',
  importance: 'importance',
  stage:      'stage',
};

interface QueueGroup {
  key: string;
  title: string;
  items: QueueItem[];
}

interface Props {
  onSelect: (concept: Concept) => void;
  selectedConcept: Concept | null;
  onDeleted?: (conceptId: number) => void;
}

export default function ReviewQueue({ onSelect, selectedConcept, onDeleted }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingConceptDeletes, setPendingConceptDeletes] = useState<QueueItem[]>([]);
  const pendingConceptDeleteTimers = React.useRef<Map<number, number>>(new Map());
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroups());
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 420);
  const [activeActionConceptId, setActiveActionConceptId] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const stored = localStorage.getItem(SORT_KEY);
    return SORT_CYCLE.includes(stored as SortMode) ? (stored as SortMode) : 'default';
  });

  const refresh = useCallback(() => {
    setLoading(true);
    window.api.review.queue(50).then(r => {
      setItems(r as QueueItem[]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // On first load, open only the source you were most recently previewing and
  // collapse the rest. Runs once per mount; manual toggles take over afterward.
  const didInitGroups = useRef(false);
  useEffect(() => {
    if (didInitGroups.current || items.length === 0) return;
    didInitGroups.current = true;
    const lastRaw = localStorage.getItem(LAST_SOURCE_KEY);
    const last = lastRaw != null ? Number(lastRaw) : NaN;
    const keys = new Set(items.map(it => String(it.source_id)));
    if (Number.isFinite(last) && keys.has(String(last))) {
      keys.delete(String(last));
      setCollapsedGroups(keys);
    }
  }, [items]);

  // Refetch whenever another part of the app signals that mastery /
  // review-history state changed (evidence submit, history delete, task
  // regenerate). Avoids stale "never reviewed" queue metadata.
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener('starcall:review-queue-stale', onChanged);
    return () => window.removeEventListener('starcall:review-queue-stale', onChanged);
  }, [refresh]);

  useEffect(() => {
    const onDeleted = (event: Event) => {
      const conceptId = (event as CustomEvent<{ conceptId?: number }>).detail?.conceptId;
      if (typeof conceptId === 'number') {
        setItems(prev => prev.filter(item => item.concept.id !== conceptId));
      }
      refresh();
    };
    window.addEventListener('starcall:concept-deleted', onDeleted);
    return () => window.removeEventListener('starcall:concept-deleted', onDeleted);
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify([...collapsedGroups]));
  }, [collapsedGroups]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  useEffect(() => {
    localStorage.setItem(SORT_KEY, sortMode);
  }, [sortMode]);

  function cycleSort() {
    const idx = SORT_CYCLE.indexOf(sortMode);
    setSortMode(SORT_CYCLE[(idx + 1) % SORT_CYCLE.length]);
  }

  function toggleGroup(key: string): void {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function deleteConceptFromQueue(item: QueueItem): void {
    if (pendingConceptDeleteTimers.current.has(item.concept.id)) return;
    setItems(prev => prev.filter(entry => entry.concept.id !== item.concept.id));
    setPendingConceptDeletes(prev => [...prev.filter(entry => entry.concept.id !== item.concept.id), item]);
    onDeleted?.(item.concept.id);
    const timerId = window.setTimeout(() => {
      pendingConceptDeleteTimers.current.delete(item.concept.id);
      setPendingConceptDeletes(prev => prev.filter(entry => entry.concept.id !== item.concept.id));
      void window.api.concepts.delete(item.concept.id).then(() => {
        window.dispatchEvent(new CustomEvent('starcall:concept-deleted', { detail: { conceptId: item.concept.id } }));
        window.dispatchEvent(new Event('starcall:review-queue-stale'));
      }).catch(() => {
        setItems(prev => prev.some(entry => entry.concept.id === item.concept.id) ? prev : [item, ...prev]);
      });
    }, 5_000);
    pendingConceptDeleteTimers.current.set(item.concept.id, timerId);
  }

  // Mark reviewed: optimistically drop from the queue, then persist. Unlike
  // delete this is a soft, reversible flag (no data loss), so it commits
  // immediately rather than via an undo window.
  function markReviewedFromQueue(item: QueueItem): void {
    setItems(prev => prev.filter(entry => entry.concept.id !== item.concept.id));
    void window.api.concepts.setReviewed({ conceptId: item.concept.id, reviewed: true })
      .then(() => window.dispatchEvent(new Event('starcall:review-queue-stale')))
      .catch(() => setItems(prev => prev.some(e => e.concept.id === item.concept.id) ? prev : [item, ...prev]));
  }

  function undoDeleteConcept(item: QueueItem): void {
    const timerId = pendingConceptDeleteTimers.current.get(item.concept.id);
    if (timerId != null) {
      window.clearTimeout(timerId);
      pendingConceptDeleteTimers.current.delete(item.concept.id);
    }
    setPendingConceptDeletes(prev => prev.filter(entry => entry.concept.id !== item.concept.id));
    setItems(prev => prev.some(entry => entry.concept.id === item.concept.id) ? prev : [item, ...prev]);
  }

  // Apply sort over the already-fetched list. Default keeps the backend
  // ordering (never-reviewed → centrality → importance → recency). Tiebreaker
  // for the explicit sorts is concept name A→Z.
  const displayedItems = useMemo(() => {
    if (sortMode === 'default') return items;
    const cmpName = (a: QueueItem, b: QueueItem) => a.concept.name.localeCompare(b.concept.name);
    if (sortMode === 'importance') {
      return [...items].sort((a, b) => {
        const ai = IMP_RANK[a.concept.importance] ?? 99;
        const bi = IMP_RANK[b.concept.importance] ?? 99;
        return ai - bi || cmpName(a, b);
      });
    }
    // stage: highest stage on top
    return [...items].sort((a, b) => (b.compression_stage - a.compression_stage) || cmpName(a, b));
  }, [items, sortMode]);

  const activeSourceKey = localStorage.getItem(LAST_SOURCE_KEY) ?? '';

  const groupedItems = useMemo<QueueGroup[]>(() => {
    const groups = new Map<string, QueueGroup>();
    for (const item of displayedItems) {
      const title = item.source_title || item.source_filename || 'Untitled source';
      const key = String(item.source_id);
      const group = groups.get(key) ?? { key, title, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [displayedItems]);

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
        width: 36, borderRight: '1px solid #1f2937', background: 'rgba(13, 13, 22, 0.5)',
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
            onClick={cycleSort}
            title="Cycle sort: default → importance → stage"
            style={{
              background: 'transparent', border: '1px solid #263244', borderRadius: 4,
              padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: '#94a3b8',
              whiteSpace: 'nowrap',
            }}
          >
            sort: {SORT_LABEL[sortMode]}
          </button>
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
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {pendingConceptDeletes.map(item => (
          <div
            key={item.concept.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: '8px 12px',
              background: '#111827',
              border: '1px solid #312e81',
              borderRadius: 6,
              padding: '8px 10px',
              color: '#cbd5e1',
              fontSize: 12,
            }}
          >
            <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Deleted {item.concept.name}.
            </span>
            <button
              onClick={() => undoDeleteConcept(item)}
              style={{
                marginLeft: 'auto',
                background: '#1e1b4b',
                border: '1px solid #6366f1',
                borderRadius: 4,
                color: '#c7d2fe',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                padding: '3px 9px',
                flexShrink: 0,
              }}
            >
              Undo
            </button>
          </div>
        ))}
        {groupedItems.map(group => {
          const isActive = group.key === activeSourceKey;
          return (
          <div key={group.key}>
            <button
              onClick={() => toggleGroup(group.key)}
              title={`${collapsedGroups.has(group.key) ? 'Expand' : 'Collapse'} ${group.title}${isActive ? ' · currently active source' : ''}`}
              style={{
              position: 'sticky', top: 0, zIndex: 2,
              padding: '8px 20px 7px',
              borderBottom: '1px solid #1f2937',
              borderLeft: `2px solid ${isActive ? '#818cf8' : '#2a2f45'}`,
              borderRight: 'none',
              borderTop: 'none',
              width: '100%',
              background: isActive ? 'rgba(129, 140, 248, 0.12)' : 'transparent',
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer',
              textAlign: 'left',
            }}>
              <span style={{ width: 12, color: isActive ? '#a5b4fc' : '#64748b', fontSize: 11, flexShrink: 0 }}>
                {collapsedGroups.has(group.key) ? '>' : 'v'}
              </span>
              <div style={{
                minWidth: 0, flex: 1,
                fontSize: 10, fontWeight: 800, color: isActive ? '#c7d2fe' : '#e2e8f0',
                textTransform: 'uppercase', letterSpacing: '0.09em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {group.title}
              </div>
              <span style={{ fontSize: 10, color: isActive ? '#818cf8' : '#64748b', flexShrink: 0 }}>
                {group.items.length}
              </span>
            </button>
            {!collapsedGroups.has(group.key) && group.items.map(it => {
              const c = it.concept;
              const stage = it.compression_stage;
              const actionsVisible = activeActionConceptId === c.id;
              const selected = selectedConcept?.id === c.id;
              return (
                <div
                  key={c.id}
                  onClick={() => onSelect(c as unknown as Concept)}
                  onMouseEnter={() => setActiveActionConceptId(c.id)}
                  onMouseLeave={() => setActiveActionConceptId(prev => prev === c.id ? null : prev)}
                  onFocus={() => setActiveActionConceptId(c.id)}
                  onBlur={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setActiveActionConceptId(prev => prev === c.id ? null : prev);
                    }
                  }}
                  style={{
                    padding: '12px 16px 11px 20px',
                    borderBottom: '1px solid #111827',
                    borderLeft: `2px solid ${selected ? '#818cf8' : 'transparent'}`,
                    background: selected ? 'rgba(129, 140, 248, 0.14)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {(() => {
                        const reviewable = it.attempts > 0;
                        return (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            if (reviewable) markReviewedFromQueue(it);
                          }}
                          disabled={!reviewable}
                          title={reviewable ? 'Mark reviewed (remove from queue)' : 'Review this concept at least once before marking it done'}
                          aria-label={`Mark ${c.name} reviewed`}
                          style={{
                            width: 20, height: 20,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            background: reviewable && actionsVisible ? 'rgba(34, 197, 94, 0.12)' : 'transparent',
                            border: `1px solid ${reviewable && actionsVisible ? 'rgba(34, 197, 94, 0.5)' : 'transparent'}`,
                            borderRadius: 4,
                            color: reviewable ? '#22c55e' : '#475569',
                            fontSize: 12,
                            lineHeight: 1, cursor: reviewable ? 'pointer' : 'not-allowed',
                            flexShrink: 0,
                            opacity: reviewable ? (actionsVisible ? 1 : 0.25) : 0.4,
                            transition: 'opacity 120ms ease, background 120ms ease, border-color 120ms ease',
                          }}
                        >
                          ✓
                        </button>
                        );
                      })()}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          deleteConceptFromQueue(it);
                        }}
                        title="Delete this concept"
                        aria-label={`Delete ${c.name}`}
                        style={{
                          width: 20, height: 20,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          background: actionsVisible ? 'rgba(248, 113, 113, 0.10)' : 'transparent',
                          border: actionsVisible ? '1px solid rgba(248, 113, 113, 0.45)' : '1px solid transparent',
                          borderRadius: 4,
                          color: '#f87171',
                          fontSize: 13,
                          lineHeight: 1,
                          cursor: 'pointer',
                          flexShrink: 0,
                          opacity: actionsVisible ? 1 : 0.25,
                          transition: 'opacity 120ms ease, background 120ms ease, border-color 120ms ease',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div style={{ paddingRight: 32, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#6b7280' }}>
                    <span style={{
                      color: IMP_COLOR[c.importance] ?? '#94a3b8',
                      background: 'rgba(129, 140, 248, 0.10)',
                      border: '1px solid rgba(129, 140, 248, 0.28)',
                      borderRadius: 999,
                      padding: '1px 6px',
                      lineHeight: 1.5,
                      whiteSpace: 'nowrap',
                    }}>
                      {c.importance}
                    </span>
                    <span style={{
                      color: STAGE_COLORS[stage],
                      textTransform: 'lowercase',
                      whiteSpace: 'nowrap',
                    }}>
                      {STAGES[stage]}
                    </span>
                    {it.attempts > 0 ? (
                      <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{it.attempts} {it.attempts === 1 ? 'try' : 'tries'}</span>
                    ) : (
                      <span style={{ color: '#f59e0b', marginLeft: 'auto', whiteSpace: 'nowrap' }}>never reviewed</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          );
        })}
      </div>
    </aside>
  );
}

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter(v => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}
