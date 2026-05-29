import React, { useEffect, useMemo, useRef, useState } from 'react';
import DetailPane from './DetailPane';
import type { Concept } from './ConceptPane';
import type { Profile } from './profile';

interface GraphNode {
  id: number;
  name: string;
  slug: string;
  source_id: number;
  source_filename?: string;
  importance: string;
  mastery_stage: number;
  degree: number;
}
interface GraphEdge {
  a: number;
  b: number;
  kind: 'constellation' | 'relation';
  label?: string;
  directed?: boolean;
}
interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  danglingConstellations: number;
  unresolvedRelations: number;
  duplicateEdges: number;
  capped: boolean;
}
interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

// Mastery stage drives the ring around each star.
const STAGE_COLORS = ['#374151', '#6b7280', '#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e'];
// Distinct per-source star colors (assigned by source order). Star body/glow is
// colored by source; the ring encodes mastery.
const SOURCE_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee',
  '#fb7185', '#a3e635', '#f59e0b', '#818cf8', '#2dd4bf', '#e879f9',
];
const IMPORTANCE_WEIGHT: Record<string, number> = {
  foundational: 4, core: 3, supporting: 2, peripheral: 1, reference_only: 0,
};

function nodeRadius(n: GraphNode): number {
  const base = 5 + Math.sqrt(n.degree) * 3 + (IMPORTANCE_WEIGHT[n.importance] ?? 0) * 1.4;
  return Math.max(5, Math.min(26, base));
}

interface Props {
  profile?: Profile;
  onConceptChanged?: () => void;
}

export default function ConstellationMap({ profile, onConceptChanged }: Props) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Concept | null>(null);
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{ x: number; y: number; text: string } | null>(null);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  // Distinct sources (sorted by id for stable colors) → palette color.
  const sources = useMemo(() => {
    if (!graph) return [];
    const seen = new Map<number, string>();
    for (const n of graph.nodes) {
      if (!seen.has(n.source_id)) seen.set(n.source_id, n.source_filename ?? `Source ${n.source_id}`);
    }
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, filename], i) => ({ id, filename, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length] }));
  }, [graph]);
  const sourceColor = useMemo(() => new Map(sources.map(s => [s.id, s.color])), [sources]);
  const sourceName = useMemo(() => new Map(sources.map(s => [s.id, s.filename])), [sources]);

  // Map shows the selected source's concepts PLUS any concept from another
  // source that is directly linked to one of them (constellation/relation),
  // so cross-source connections stay visible without dumping every source in.
  const view = useMemo(() => {
    if (!graph || selectedSource == null) return { nodes: [], edges: [] as GraphEdge[] };
    const primary = new Set(graph.nodes.filter(n => n.source_id === selectedSource).map(n => n.id));
    const visible = new Set(primary);
    for (const e of graph.edges) {
      if (primary.has(e.a)) visible.add(e.b);
      if (primary.has(e.b)) visible.add(e.a);
    }
    const nodes = graph.nodes.filter(n => visible.has(n.id));
    const edges = graph.edges.filter(e => visible.has(e.a) && visible.has(e.b));
    return { nodes, edges };
  }, [graph, selectedSource]);

  const simRef = useRef<SimNode[]>([]);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef(0);
  const stepRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<{ id: number; ox: number; oy: number } | null>(null);
  const viewRef = useRef<{ tx: number; ty: number; scale: number }>({ tx: 0, ty: 0, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setLoading(true);
    window.api.concepts.graph().then(g => {
      const graphData = g as Graph;
      setGraph(graphData);
      // Default to the source with the most concepts.
      const counts = new Map<number, number>();
      for (const n of graphData.nodes) counts.set(n.source_id, (counts.get(n.source_id) ?? 0) + 1);
      let best: number | null = null, bestN = -1;
      for (const [sid, c] of counts) if (c > bestN) { bestN = c; best = sid; }
      setSelectedSource(best);
      setLoading(false);
    });
  }, []);

  // Initialize positions + run the force simulation for the visible (toggled)
  // node set; re-runs whenever the source filter changes.
  useEffect(() => {
    if (view.nodes.length === 0) { simRef.current = []; forceTick(t => t + 1); return; }
    const W = 1000, H = 700;
    const cx = W / 2, cy = H / 2;
    const n = view.nodes.length;
    simRef.current = view.nodes.map((node, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      const radius = 60 + (i % 7) * 28;
      return {
        ...node,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0, vy: 0, fixed: false,
      };
    });
    const idx = new Map(simRef.current.map((s, i) => [s.id, i]));
    const links = view.edges
      .map(e => ({ s: idx.get(e.a), t: idx.get(e.b) }))
      .filter((l): l is { s: number; t: number } => l.s != null && l.t != null);

    const REPULSION = 1400;
    const SPRING = 0.02;
    const REST = 90;
    const CENTER = 0.006;
    const DAMP = 0.86;
    tickRef.current = 0;
    const MAX_TICKS = 320;

    function step() {
      const nodes = simRef.current;
      // Repulsion (O(n^2); n<=150).
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
          const f = REPULSION / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }
      // Springs along edges.
      for (const l of links) {
        const a = nodes[l.s], b = nodes[l.t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING * (d - REST);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      // Centering + integrate.
      for (const nd of nodes) {
        if (nd.fixed) { nd.vx = 0; nd.vy = 0; continue; }
        nd.vx += (cx - nd.x) * CENTER;
        nd.vy += (cy - nd.y) * CENTER;
        nd.vx *= DAMP; nd.vy *= DAMP;
        nd.x += nd.vx; nd.y += nd.vy;
      }
      tickRef.current += 1;
      forceTick(t => t + 1);
      if (tickRef.current < MAX_TICKS || dragRef.current) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    }
    stepRef.current = step;
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [view]);

  // Resume/extend the settle loop (after drag, etc.) so neighbors re-relax.
  function resume() {
    tickRef.current = 0;
    if (rafRef.current == null && stepRef.current) {
      rafRef.current = requestAnimationFrame(stepRef.current);
    }
  }

  function screenToGraph(clientX: number, clientY: number): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    const { tx, ty, scale } = viewRef.current;
    const sx = rect ? clientX - rect.left : clientX;
    const sy = rect ? clientY - rect.top : clientY;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }

  function onNodeMouseDown(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    const node = simRef.current.find(s => s.id === id);
    if (!node) return;
    node.fixed = true;
    const p = screenToGraph(e.clientX, e.clientY);
    dragRef.current = { id, ox: node.x - p.x, oy: node.y - p.y };
    resume();
  }

  function onMouseMove(e: React.MouseEvent) {
    if (dragRef.current) {
      const node = simRef.current.find(s => s.id === dragRef.current!.id);
      if (node) {
        const p = screenToGraph(e.clientX, e.clientY);
        node.x = p.x + dragRef.current.ox;
        node.y = p.y + dragRef.current.oy;
        forceTick(t => t + 1);
      }
    } else if (panRef.current) {
      viewRef.current.tx = panRef.current.tx + (e.clientX - panRef.current.x);
      viewRef.current.ty = panRef.current.ty + (e.clientY - panRef.current.y);
      forceTick(t => t + 1);
    }
  }

  function onMouseUp() {
    if (dragRef.current) {
      const node = simRef.current.find(s => s.id === dragRef.current!.id);
      if (node) node.fixed = false;
      dragRef.current = null;
      resume();
    }
    panRef.current = null;
  }

  function onBackgroundMouseDown(e: React.MouseEvent) {
    panRef.current = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
  }

  function onWheel(e: React.WheelEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : e.clientX;
    const my = rect ? e.clientY - rect.top : e.clientY;
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(0.25, Math.min(3, v.scale * factor));
    // Zoom toward the cursor.
    v.tx = mx - (mx - v.tx) * (newScale / v.scale);
    v.ty = my - (my - v.ty) * (newScale / v.scale);
    v.scale = newScale;
    forceTick(t => t + 1);
  }

  async function openNode(id: number) {
    const c = await window.api.concepts.get(id);
    if (c) setSelected(c as Concept);
  }


  const neighbors = useMemo(() => {
    if (hoverNode == null) return null;
    const set = new Set<number>([hoverNode]);
    for (const e of view.edges) {
      if (e.a === hoverNode) set.add(e.b);
      if (e.b === hoverNode) set.add(e.a);
    }
    return set;
  }, [hoverNode, view]);

  const sim = simRef.current;
  const posById = new Map(sim.map(s => [s.id, s]));
  const { tx, ty, scale } = viewRef.current;

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative', zIndex: 1 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid rgba(31,41,55,0.72)',
          background: 'rgba(4,6,26,0.4)', backdropFilter: 'blur(14px)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          {sources.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: sourceColor.get(selectedSource ?? -1) ?? '#94a3b8', flexShrink: 0 }} />
              <select
                value={selectedSource ?? ''}
                onChange={e => setSelectedSource(Number(e.target.value))}
                title="Choose which source's constellation to view (linked concepts from other sources are shown automatically)"
                style={{
                  background: '#111827', border: '1px solid #263244', borderRadius: 4,
                  padding: '4px 8px', color: '#e2e8f0', fontSize: 11, outline: 'none',
                  maxWidth: 260, cursor: 'pointer',
                }}
              >
                {sources.map(s => (
                  <option key={s.id} value={s.id}>{s.filename}</option>
                ))}
              </select>
              <span style={{ fontSize: 10, color: '#475569' }}>+ linked sources shown</span>
            </div>
          )}
          <span style={{ fontSize: 11, color: '#6b7280' }}>drag · scroll to zoom · drag bg to pan</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: '#94a3b8' }}>
            <Legend />
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'radial-gradient(circle at 50% 40%, rgba(30,27,75,0.35), rgba(2,6,23,0.0))' }}>
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', fontSize: 13 }}>Loading map…</div>
          )}
          {!loading && graph && graph.nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 13, textAlign: 'center', padding: 40 }}>
              No promoted concepts yet. Promote concepts and link them via a concept's Overview to populate the map.
            </div>
          )}
          {!loading && graph && graph.nodes.length > 0 && view.nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 13, textAlign: 'center', padding: 40 }}>
              Select a source above to view its constellation.
            </div>
          )}
          {!loading && graph && view.nodes.length > 0 && (
            <svg
              ref={svgRef}
              width="100%" height="100%"
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onMouseDown={onBackgroundMouseDown}
              onWheel={onWheel}
              style={{ display: 'block', cursor: panRef.current ? 'grabbing' : 'default' }}
            >
              <defs>
                {sources.map(s => (
                  <React.Fragment key={s.id}>
                    <radialGradient id={`cm-core-${s.id}`}>
                      <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
                      <stop offset="55%" stopColor={s.color} stopOpacity={0.95} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={0.8} />
                    </radialGradient>
                    <radialGradient id={`cm-halo-${s.id}`}>
                      <stop offset="0%" stopColor={s.color} stopOpacity={0.5} />
                      <stop offset="60%" stopColor={s.color} stopOpacity={0.12} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                    </radialGradient>
                  </React.Fragment>
                ))}
                <marker id="cm-arrow-con" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 Z" fill="#c084fc" />
                </marker>
                <marker id="cm-arrow-cross" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 Z" fill="#f472b6" />
                </marker>
              </defs>
              <g className="cm-graph" transform={`translate(${tx},${ty}) scale(${scale})`}>
                {view.edges.map((e, i) => {
                  const a = posById.get(e.a), b = posById.get(e.b);
                  if (!a || !b) return null;
                  const active = neighbors == null || (neighbors.has(e.a) && neighbors.has(e.b));
                  const bidir = e.directed === false;
                  // Dashed line = the link crosses sources (connects two books);
                  // solid = both concepts live in the same source.
                  const crossSource = a.source_id !== b.source_id;
                  const color = crossSource ? '#fdba74' : '#818cf8';
                  const marker = crossSource ? 'url(#cm-arrow-cross)' : 'url(#cm-arrow-con)';
                  // Trim the line to each node's edge so arrowheads sit on the rim.
                  const dx = b.x - a.x, dy = b.y - a.y;
                  const d = Math.hypot(dx, dy) || 1;
                  const ux = dx / d, uy = dy / d;
                  const ra = nodeRadius(a) + 1.5, rb = nodeRadius(b) + 1.5;
                  const x1 = a.x + ux * ra, y1 = a.y + uy * ra;
                  const x2 = b.x - ux * rb, y2 = b.y - uy * rb;
                  const tip = `${bidir ? 'mutual ↔' : 'one-way →'}${crossSource ? ' · cross-source' : ''}${e.label ? ' · ' + e.label : ''}`;
                  return (
                    <line
                      key={i}
                      className={crossSource ? 'cm-relation-edge' : undefined}
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={color}
                      strokeWidth={bidir ? 1.7 : 1.2}
                      strokeLinecap="round"
                      strokeDasharray={crossSource ? '5 4' : undefined}
                      strokeOpacity={active ? (bidir ? 0.75 : 0.55) : 0.06}
                      markerEnd={active ? marker : undefined}
                      markerStart={active && bidir ? marker : undefined}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoverEdge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: tip })}
                      onMouseLeave={() => setHoverEdge(null)}
                    />
                  );
                })}
                {sim.map(node => {
                  const r = nodeRadius(node);
                  const dim = neighbors != null && !neighbors.has(node.id);
                  const stage = Math.max(0, Math.min(5, node.mastery_stage));
                  const ring = STAGE_COLORS[stage];
                  const isSel = selected?.id === node.id;
                  const isHover = hoverNode === node.id;
                  return (
                    <g key={node.id} transform={`translate(${node.x},${node.y})`} style={{ cursor: 'pointer' }}
                       onMouseEnter={() => setHoverNode(node.id)}
                       onMouseLeave={() => setHoverNode(h => (h === node.id ? null : h))}
                       onMouseDown={e => onNodeMouseDown(e, node.id)}
                       onClick={e => { e.stopPropagation(); void openNode(node.id); }}>
                      <g className="cm-node-inner" style={{ opacity: dim ? 0.2 : 1, transform: isHover ? 'scale(1.38)' : 'scale(1)' }}>
                        {isSel && (
                          <circle r={r + 4} fill="none" stroke="#e2e8f0" strokeWidth={1.4}>
                            <animate attributeName="r" values={`${r + 3};${r + 14}`} dur="1.8s" repeatCount="indefinite" />
                            <animate attributeName="opacity" values="0.85;0" dur="1.8s" repeatCount="indefinite" />
                          </circle>
                        )}
                        <circle
                          className="cm-halo"
                          r={r * 2.6}
                          fill={`url(#cm-halo-${node.source_id})`}
                          style={{ animationDelay: `${(node.id % 17) * 0.23}s` }}
                        />
                        {/* Mastery ring: thicker + brighter as the stage climbs. */}
                        <circle r={r + 1.5} fill="none" stroke={ring} strokeWidth={0.6 + stage * 0.5} strokeOpacity={stage === 0 ? 0.35 : 0.85} />
                        <circle r={r} fill={`url(#cm-core-${node.source_id})`} stroke={sourceColor.get(node.source_id) ?? '#94a3b8'} strokeWidth={0.6} strokeOpacity={0.65} />
                        <circle
                          className="cm-spark"
                          r={Math.max(1.3, r * 0.34)}
                          fill="#ffffff"
                          style={{ animationDelay: `${(node.id % 13) * 0.31}s` }}
                        />
                      </g>
                      {(!dim && (r >= 11 || isHover || isSel)) && (
                        <text
                          x={r + 6} y={4}
                          fontSize={11}
                          fill={isHover || isSel ? '#f1f5f9' : '#cbd5e1'}
                          style={{
                            pointerEvents: 'none', userSelect: 'none',
                            paintOrder: 'stroke', stroke: 'rgba(2,6,23,0.9)', strokeWidth: 3, strokeLinejoin: 'round',
                            fontWeight: isHover || isSel ? 700 : 400,
                          }}
                        >
                          {node.name.length > 28 ? node.name.slice(0, 27) + '…' : node.name}
                        </text>
                      )}
                      {(isHover || isSel) && (
                        <text
                          x={r + 6} y={18}
                          fontSize={9.5}
                          fill={sourceColor.get(node.source_id) ?? '#94a3b8'}
                          style={{
                            pointerEvents: 'none', userSelect: 'none',
                            paintOrder: 'stroke', stroke: 'rgba(2,6,23,0.92)', strokeWidth: 3, strokeLinejoin: 'round',
                          }}
                        >
                          {(() => { const f = sourceName.get(node.source_id) ?? ''; return f.length > 32 ? f.slice(0, 31) + '…' : f; })()}
                        </text>
                      )}
                    </g>
                  );
                })}
                {hoverEdge && (
                  <g transform={`translate(${hoverEdge.x},${hoverEdge.y})`} style={{ pointerEvents: 'none' }}>
                    <rect x={-2} y={-16} width={hoverEdge.text.length * 6.6 + 12} height={18} rx={3} fill="rgba(2,6,23,0.92)" stroke="#312e81" />
                    <text x={6} y={-3} fontSize={11} fill="#c7d2fe">{hoverEdge.text}</text>
                  </g>
                )}
              </g>
            </svg>
          )}
        </div>

        {graph && (
          <div style={{
            padding: '5px 16px', borderTop: '1px solid rgba(31,41,55,0.72)',
            background: 'rgba(4,6,26,0.5)', fontSize: 10, color: '#64748b',
            display: 'flex', gap: 16, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
          }}>
            <span><span style={{ color: '#475569' }}>nodes</span> {graph.stats.nodeCount}</span>
            <span><span style={{ color: '#475569' }}>edges</span> {graph.stats.edgeCount}</span>
            <span><span style={{ color: '#475569' }}>dangling</span> {graph.stats.danglingConstellations}</span>
            <span><span style={{ color: '#475569' }}>unresolved rel</span> {graph.stats.unresolvedRelations}</span>
            <span><span style={{ color: '#475569' }}>dupes</span> {graph.stats.duplicateEdges}</span>
            {graph.stats.capped && <span style={{ color: '#f59e0b' }}>Showing highest-degree / highest-importance concepts.</span>}
          </div>
        )}
      </div>

      {selected && (
        <div style={{ flex: '0 0 600px', maxWidth: '52%', display: 'flex', borderLeft: '1px solid #1f2937', position: 'relative' }}>
          <button
            onClick={() => setSelected(null)}
            title="Close"
            style={{ position: 'absolute', top: 8, right: 10, zIndex: 5, background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 4, color: '#c7d2fe', fontSize: 13, lineHeight: 1, padding: '2px 8px', cursor: 'pointer' }}
          >×</button>
          <DetailPane
            concept={selected}
            profile={profile}
            onDeleted={() => { setSelected(null); onConceptChanged?.(); }}
          />
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="9" viewBox="0 0 24 9"><line x1="0" y1="4.5" x2="18" y2="4.5" stroke="#818cf8" strokeWidth="1.4" /><path d="M18,1.5 L24,4.5 L18,7.5 Z" fill="#c084fc" /></svg>
        one-way
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="28" height="9" viewBox="0 0 28 9"><line x1="6" y1="4.5" x2="22" y2="4.5" stroke="#818cf8" strokeWidth="1.7" /><path d="M6,1.5 L0,4.5 L6,7.5 Z" fill="#c084fc" /><path d="M22,1.5 L28,4.5 L22,7.5 Z" fill="#c084fc" /></svg>
        mutual
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="9" viewBox="0 0 24 9"><line x1="0" y1="4.5" x2="18" y2="4.5" stroke="#fdba74" strokeWidth="1.4" strokeDasharray="4 3" /><path d="M18,1.5 L24,4.5 L18,7.5 Z" fill="#f472b6" /></svg>
        cross-source
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid #22c55e', display: 'inline-block', boxSizing: 'border-box' }} />
        mastery ring
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'radial-gradient(circle, #fff 30%, #60a5fa 100%)', display: 'inline-block' }} />
        color = source
      </span>
    </div>
  );
}
