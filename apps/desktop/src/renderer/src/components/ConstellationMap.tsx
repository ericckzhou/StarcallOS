import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DetailPane from './DetailPane';
import type { Concept } from './ConceptPane';
import type { Profile } from './profile';
import { LAST_SOURCE_KEY } from '../App';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  statsBySource: Record<number, {
    danglingConstellations: number;
    unresolvedRelations: number;
    duplicateEdges: number;
  }>;
}
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}
interface SourceMeta {
  id: number;
  filename: string;
  color: string;
}
interface HubLite { id: number; name: string; color: string; member_count: number; description: string; }

// ─── Design constants ──────────────────────────────────────────────────────────

// Mastery ring ramps from least → most proficient: orange → yellow → green.
// Stage 0 (unseen) sits at the orange end but is drawn faint (see strokeOpacity).
const STAGE_COLORS = ['#f97316', '#fb923c', '#fbbf24', '#facc15', '#a3e635', '#22c55e'];
const SOURCE_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee',
  '#fb7185', '#a3e635', '#f59e0b', '#818cf8', '#2dd4bf', '#e879f9',
];
const IMPORTANCE_WEIGHT: Record<string, number> = {
  foundational: 4, core: 3, supporting: 2, peripheral: 1, reference_only: 0,
};
const SAME_SOURCE_EDGE = '#818cf8';
const CROSS_SOURCE_EDGE = '#fdba74';
// z-index scale for layered map chrome.
const Z = { graph: 1, panelClose: 30 } as const;

function nodeRadius(n: { degree: number; importance: string }): number {
  const base = 5 + Math.sqrt(n.degree) * 3 + (IMPORTANCE_WEIGHT[n.importance] ?? 0) * 1.4;
  return Math.max(5, Math.min(26, base));
}

// ─── Hooks ──────────────────────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

// Fetch the graph, derive per-source colors, and compute the focused view
// (selected source + concepts linked to it from other sources).
function useConstellationGraph() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [hubs, setHubs] = useState<HubLite[]>([]);
  const [conceptHubs, setConceptHubs] = useState<Map<number, number[]>>(new Map());

  const refreshHubs = useCallback(() => {
    Promise.all([window.api.hubs.list(), window.api.hubs.memberships()]).then(([hs, ms]) => {
      setHubs((hs as HubLite[]).map(h => ({ id: h.id, name: h.name, color: h.color, member_count: h.member_count, description: h.description })));
      const m = new Map<number, number[]>();
      for (const { hub_id, concept_id } of ms as Array<{ hub_id: number; concept_id: number }>) {
        const arr = m.get(concept_id) ?? [];
        arr.push(hub_id);
        m.set(concept_id, arr);
      }
      setConceptHubs(m);
    });
  }, []);
  useEffect(() => { refreshHubs(); }, [refreshHubs]);

  // Initial source selection runs only once; later refetches (e.g. after a
  // constellation edit) just update the graph data and keep the user's view.
  const didInitSourceRef = useRef(false);
  const loadGraph = useCallback(() => {
    window.api.concepts.graph().then(g => {
      const data = g as Graph;
      setGraph(data);
      if (!didInitSourceRef.current) {
        didInitSourceRef.current = true;
        const present = new Set(data.nodes.map(n => n.source_id));
        // Default to the source you were most recently previewing in the
        // Sources tab, if it's still on the map; else the largest source.
        const lastRaw = localStorage.getItem(LAST_SOURCE_KEY);
        const last = lastRaw != null ? Number(lastRaw) : NaN;
        if (Number.isFinite(last) && present.has(last)) {
          setSelectedSource(last);
        } else {
          const counts = new Map<number, number>();
          for (const n of data.nodes) counts.set(n.source_id, (counts.get(n.source_id) ?? 0) + 1);
          let best: number | null = null, bestN = -1;
          for (const [sid, c] of counts) if (c > bestN) { bestN = c; best = sid; }
          setSelectedSource(best);
        }
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => { setLoading(true); loadGraph(); }, [loadGraph]);

  // Refetch when constellations/edges change elsewhere so deleted links drop
  // off the map without a manual reload.
  useEffect(() => {
    const handler = () => loadGraph();
    window.addEventListener('starcall:graphChanged', handler);
    return () => window.removeEventListener('starcall:graphChanged', handler);
  }, [loadGraph]);

  const sources = useMemo<SourceMeta[]>(() => {
    if (!graph) return [];
    const seen = new Map<number, string>();
    for (const n of graph.nodes) {
      if (!seen.has(n.source_id)) seen.set(n.source_id, n.source_filename ?? `Source ${n.source_id}`);
    }
    // Color by source_id (stable) rather than array index, so deleting a
    // concept/source never reshuffles the remaining sources' colors.
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, filename]) => ({ id, filename, color: SOURCE_PALETTE[Math.abs(id) % SOURCE_PALETTE.length] }));
  }, [graph]);
  const sourceColor = useMemo(() => new Map(sources.map(s => [s.id, s.color])), [sources]);
  const sourceName = useMemo(() => new Map(sources.map(s => [s.id, s.filename])), [sources]);

  const view = useMemo(() => {
    if (!graph || selectedSource == null) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const primary = new Set(graph.nodes.filter(n => n.source_id === selectedSource).map(n => n.id));
    const visible = new Set(primary);
    for (const e of graph.edges) {
      if (primary.has(e.a)) visible.add(e.b);
      if (primary.has(e.b)) visible.add(e.a);
    }
    return {
      nodes: graph.nodes.filter(n => visible.has(n.id)),
      edges: graph.edges.filter(e => visible.has(e.a) && visible.has(e.b)),
    };
  }, [graph, selectedSource]);

  return { graph, loading, sources, sourceColor, sourceName, selectedSource, setSelectedSource, view, hubs, conceptHubs, refreshHubs };
}

interface ForceLayout {
  svgRef: React.RefObject<SVGSVGElement>;
  sim: SimNode[];
  tx: number; ty: number; scale: number;
  panning: boolean;
  onSvgMouseMove: (e: React.MouseEvent) => void;
  onSvgMouseUp: () => void;
  onBackgroundMouseDown: (e: React.MouseEvent) => void;
  onWheel: (e: React.WheelEvent) => void;
  beginNodeDrag: (e: React.MouseEvent, id: number) => void;
}

// Owns the force simulation + pan/zoom/drag. Settles synchronously when the
// user prefers reduced motion (no per-frame animation).
function useForceLayout(view: { nodes: GraphNode[]; edges: GraphEdge[] }, reducedMotion: boolean, conceptHubs: Map<number, number[]>): ForceLayout {
  const simRef = useRef<SimNode[]>([]);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef(0);
  const stepRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<{ id: number; ox: number; oy: number } | null>(null);
  const viewRef = useRef({ tx: 0, ty: 0, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [, render] = useState(0);
  const repaint = useCallback(() => render(t => t + 1), []);

  useEffect(() => {
    if (view.nodes.length === 0) { simRef.current = []; repaint(); return; }
    const W = 1000, H = 700, cx = W / 2, cy = H / 2;
    const n = view.nodes.length;
    simRef.current = view.nodes.map((node, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      const radius = 60 + (i % 7) * 28;
      return { ...node, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, vx: 0, vy: 0, fixed: false };
    });
    const idx = new Map(simRef.current.map((s, i) => [s.id, i]));
    const links = view.edges
      .map(e => ({ s: idx.get(e.a), t: idx.get(e.b) }))
      .filter((l): l is { s: number; t: number } => l.s != null && l.t != null);

    const REPULSION = 1400, SPRING = 0.02, REST = 90, CENTER = 0.006, DAMP = 0.86, MAX_TICKS = 320;
    const HUB_PULL = 0.012;
    // Which hubs each visible node belongs to (precomputed once per layout).
    const nodeHubs = simRef.current.map(s => conceptHubs.get(s.id) ?? []);
    const anyHubs = nodeHubs.some(h => h.length > 0);

    function tickOnce() {
      const nodes = simRef.current;
      // Gentle clustering: pull each node toward the centroid of its hub's
      // members so hubs visibly coalesce (without overpowering link springs).
      if (anyHubs) {
        const cen = new Map<number, { x: number; y: number; n: number }>();
        for (let i = 0; i < nodes.length; i++) {
          for (const h of nodeHubs[i]) {
            const c = cen.get(h) ?? { x: 0, y: 0, n: 0 };
            c.x += nodes[i].x; c.y += nodes[i].y; c.n += 1;
            cen.set(h, c);
          }
        }
        for (let i = 0; i < nodes.length; i++) {
          const hs = nodeHubs[i];
          if (hs.length === 0 || nodes[i].fixed) continue;
          let tx = 0, ty = 0, k = 0;
          for (const h of hs) { const c = cen.get(h)!; if (c.n > 1) { tx += c.x / c.n; ty += c.y / c.n; k += 1; } }
          if (k > 0) { nodes[i].vx += (tx / k - nodes[i].x) * HUB_PULL; nodes[i].vy += (ty / k - nodes[i].y) * HUB_PULL; }
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
          const f = REPULSION / d2, d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }
      for (const l of links) {
        const a = nodes[l.s], b = nodes[l.t];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING * (d - REST), fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const nd of nodes) {
        if (nd.fixed) { nd.vx = 0; nd.vy = 0; continue; }
        nd.vx += (cx - nd.x) * CENTER; nd.vy += (cy - nd.y) * CENTER;
        nd.vx *= DAMP; nd.vy *= DAMP; nd.x += nd.vx; nd.y += nd.vy;
      }
    }

    tickRef.current = 0;
    if (reducedMotion) {
      // Settle to the final layout in one synchronous pass — no animation.
      for (let i = 0; i < MAX_TICKS; i++) tickOnce();
      repaint();
      return;
    }
    function step() {
      tickOnce();
      tickRef.current += 1;
      repaint();
      if (tickRef.current < MAX_TICKS || dragRef.current) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = null;
    }
    stepRef.current = step;
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [view, reducedMotion, repaint, conceptHubs]);

  const resume = useCallback(() => {
    if (reducedMotion) { repaint(); return; }
    tickRef.current = 0;
    if (rafRef.current == null && stepRef.current) rafRef.current = requestAnimationFrame(stepRef.current);
  }, [reducedMotion, repaint]);

  const screenToGraph = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const { tx, ty, scale } = viewRef.current;
    const sx = rect ? clientX - rect.left : clientX;
    const sy = rect ? clientY - rect.top : clientY;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }, []);

  const beginNodeDrag = useCallback((e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    const node = simRef.current.find(s => s.id === id);
    if (!node) return;
    node.fixed = true;
    const p = screenToGraph(e.clientX, e.clientY);
    dragRef.current = { id, ox: node.x - p.x, oy: node.y - p.y };
    resume();
  }, [screenToGraph, resume]);

  const onSvgMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
      const node = simRef.current.find(s => s.id === dragRef.current!.id);
      if (node) { const p = screenToGraph(e.clientX, e.clientY); node.x = p.x + dragRef.current.ox; node.y = p.y + dragRef.current.oy; repaint(); }
    } else if (panRef.current) {
      viewRef.current.tx = panRef.current.tx + (e.clientX - panRef.current.x);
      viewRef.current.ty = panRef.current.ty + (e.clientY - panRef.current.y);
      repaint();
    }
  }, [screenToGraph, repaint]);

  const onSvgMouseUp = useCallback(() => {
    if (dragRef.current) {
      const node = simRef.current.find(s => s.id === dragRef.current!.id);
      if (node) node.fixed = false;
      dragRef.current = null;
      resume();
    }
    panRef.current = null;
  }, [resume]);

  const onBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    panRef.current = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : e.clientX;
    const my = rect ? e.clientY - rect.top : e.clientY;
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(0.25, Math.min(3, v.scale * factor));
    v.tx = mx - (mx - v.tx) * (newScale / v.scale);
    v.ty = my - (my - v.ty) * (newScale / v.scale);
    v.scale = newScale;
    repaint();
  }, [repaint]);

  return {
    svgRef, sim: simRef.current,
    tx: viewRef.current.tx, ty: viewRef.current.ty, scale: viewRef.current.scale,
    panning: panRef.current != null,
    onSvgMouseMove, onSvgMouseUp, onBackgroundMouseDown, onWheel, beginNodeDrag,
  };
}

// ─── Presentational subcomponents ────────────────────────────────────────────

interface Cluster {
  id: number; name: string; color: string;
  cx: number; cy: number; radius: number;
  points: Array<{ x: number; y: number; r: number }>;
}

// Soft hub "nebula": a centroid wash plus a feathered glow per member star,
// all using the hub's radial gradient (no blur filter → cheap per frame). The
// overlapping low-opacity gradients accumulate into a cloud hugging the cluster.
function NebulaLayer({ clusters }: { clusters: Cluster[] }) {
  return (
    <g style={{ pointerEvents: 'none' }} aria-hidden="true">
      {clusters.map(c => (
        <g key={c.id}>
          <circle cx={c.cx} cy={c.cy} r={c.radius} fill={`url(#cm-nebula-${c.id})`} />
          {c.points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={Math.max(26, p.r * 4.5)} fill={`url(#cm-nebula-${c.id})`} />
          ))}
          <text
            x={c.cx} y={c.cy - c.radius + 13} fontSize={11} textAnchor="middle" fill={c.color}
            style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,0.85)', strokeWidth: 3, strokeLinejoin: 'round', fontWeight: 700, letterSpacing: '0.04em', opacity: 0.85 }}
          >
            {c.name}
          </text>
        </g>
      ))}
    </g>
  );
}

const MapDefs = React.memo(function MapDefs({ sources, hubs }: { sources: SourceMeta[]; hubs: HubLite[] }) {
  return (
    <defs>
      {hubs.map(h => (
        <radialGradient key={`neb-${h.id}`} id={`cm-nebula-${h.id}`}>
          <stop offset="0%" stopColor={h.color} stopOpacity={0.22} />
          <stop offset="45%" stopColor={h.color} stopOpacity={0.10} />
          <stop offset="100%" stopColor={h.color} stopOpacity={0} />
        </radialGradient>
      ))}
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
  );
});

interface EdgeProps {
  ax: number; ay: number; bx: number; by: number; ra: number; rb: number;
  bidir: boolean; crossSource: boolean; active: boolean; tip: string; midX: number; midY: number;
  onHover: (t: { x: number; y: number; text: string } | null) => void;
}
const GraphEdgeLine = React.memo(function GraphEdgeLine(p: EdgeProps) {
  const dx = p.bx - p.ax, dy = p.by - p.ay, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const x1 = p.ax + ux * p.ra, y1 = p.ay + uy * p.ra;
  const x2 = p.bx - ux * p.rb, y2 = p.by - uy * p.rb;
  const marker = p.crossSource ? 'url(#cm-arrow-cross)' : 'url(#cm-arrow-con)';
  return (
    <line
      className={p.crossSource ? 'cm-relation-edge' : undefined}
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={p.crossSource ? CROSS_SOURCE_EDGE : SAME_SOURCE_EDGE}
      strokeWidth={p.bidir ? 1.7 : 1.2}
      strokeLinecap="round"
      strokeDasharray={p.crossSource ? '5 4' : undefined}
      strokeOpacity={p.active ? (p.bidir ? 0.75 : 0.55) : 0.06}
      markerEnd={p.active ? marker : undefined}
      markerStart={p.active && p.bidir ? marker : undefined}
      style={{ cursor: 'pointer' }}
      onMouseEnter={() => p.onHover({ x: p.midX, y: p.midY, text: p.tip })}
      onMouseLeave={() => p.onHover(null)}
    />
  );
});

interface StarProps {
  id: number; x: number; y: number; r: number; name: string;
  stage: number; sourceId: number; sourceColor: string; sourceName: string;
  dim: boolean; isHover: boolean; isSel: boolean; reducedMotion: boolean;
  onHoverEnter: (id: number) => void; onHoverLeave: (id: number) => void;
  onDown: (e: React.MouseEvent, id: number) => void; onOpen: (id: number) => void;
}
const StarNode = React.memo(function StarNode(p: StarProps) {
  const ring = STAGE_COLORS[p.stage];
  const showLabel = !p.dim && (p.r >= 11 || p.isHover || p.isSel);
  return (
    <g
      className="cm-node"
      transform={`translate(${p.x},${p.y})`}
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      aria-label={`${p.name} — open concept`}
      onMouseEnter={() => p.onHoverEnter(p.id)}
      onMouseLeave={() => p.onHoverLeave(p.id)}
      onMouseDown={e => p.onDown(e, p.id)}
      onClick={e => { e.stopPropagation(); p.onOpen(p.id); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(p.id); } }}
    >
      <circle className="cm-focus-ring" r={p.r + 7} fill="none" stroke="#e2e8f0" strokeWidth={1.5} strokeDasharray="3 3" opacity={0} />
      <g className="cm-node-inner" style={{ opacity: p.dim ? 0.2 : 1, transform: p.isHover ? 'scale(1.38)' : 'scale(1)' }}>
        {p.isSel && (p.reducedMotion ? (
          <circle r={p.r + 6} fill="none" stroke="#e2e8f0" strokeWidth={1.6} opacity={0.85} />
        ) : (
          <circle r={p.r + 4} fill="none" stroke="#e2e8f0" strokeWidth={1.4}>
            <animate attributeName="r" values={`${p.r + 3};${p.r + 14}`} dur="1.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.85;0" dur="1.8s" repeatCount="indefinite" />
          </circle>
        ))}
        <circle className="cm-halo" r={p.r * 2.6} fill={`url(#cm-halo-${p.sourceId})`} style={{ animationDelay: `${(p.id % 17) * 0.23}s` }} />
        {/* Soft glow ring — widens/brightens with proficiency (orange→green). */}
        {p.stage > 0 && (
          <circle r={p.r + 3.5} fill="none" stroke={ring} strokeWidth={2.4} strokeOpacity={0.1 + p.stage * 0.05} />
        )}
        <circle r={p.r + 1.5} fill="none" stroke={ring} strokeWidth={0.6 + p.stage * 0.5} strokeOpacity={p.stage === 0 ? 0.35 : 0.85} />
        <circle r={p.r} fill={`url(#cm-core-${p.sourceId})`} stroke={p.sourceColor} strokeWidth={0.6} strokeOpacity={0.65} />
        <circle className="cm-spark" r={Math.max(1.3, p.r * 0.34)} fill="#ffffff" style={{ animationDelay: `${(p.id % 13) * 0.31}s` }} />
      </g>
      {showLabel && (
        <text
          x={p.r + 6} y={4} fontSize={11}
          fill={p.isHover || p.isSel ? '#f1f5f9' : '#cbd5e1'}
          style={{ pointerEvents: 'none', userSelect: 'none', paintOrder: 'stroke', stroke: 'rgba(2,6,23,0.9)', strokeWidth: 3, strokeLinejoin: 'round', fontWeight: p.isHover || p.isSel ? 700 : 400 }}
        >
          {p.name.length > 28 ? p.name.slice(0, 27) + '…' : p.name}
        </text>
      )}
    </g>
  );
});

function EdgeTooltip({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <g transform={`translate(${x},${y})`} style={{ pointerEvents: 'none' }}>
      <rect x={-2} y={-16} width={text.length * 6.6 + 12} height={18} rx={3} fill="rgba(2,6,23,0.92)" stroke="#312e81" />
      <text x={6} y={-3} fontSize={11} fill="#c7d2fe">{text}</text>
    </g>
  );
}

function MapLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="9" viewBox="0 0 24 9" aria-hidden="true"><line x1="0" y1="4.5" x2="18" y2="4.5" stroke={SAME_SOURCE_EDGE} strokeWidth="1.4" /><path d="M18,1.5 L24,4.5 L18,7.5 Z" fill="#c084fc" /></svg>
        one-way
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="28" height="9" viewBox="0 0 28 9" aria-hidden="true"><line x1="6" y1="4.5" x2="22" y2="4.5" stroke={SAME_SOURCE_EDGE} strokeWidth="1.7" /><path d="M6,1.5 L0,4.5 L6,7.5 Z" fill="#c084fc" /><path d="M22,1.5 L28,4.5 L22,7.5 Z" fill="#c084fc" /></svg>
        mutual
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="9" viewBox="0 0 24 9" aria-hidden="true"><line x1="0" y1="4.5" x2="18" y2="4.5" stroke={CROSS_SOURCE_EDGE} strokeWidth="1.4" strokeDasharray="4 3" /><path d="M18,1.5 L24,4.5 L18,7.5 Z" fill="#f472b6" /></svg>
        cross-source
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid transparent', background: 'conic-gradient(#f97316, #facc15, #22c55e, #f97316) border-box', WebkitMask: 'radial-gradient(circle, transparent 54%, #000 56%)', display: 'inline-block', boxSizing: 'border-box' }} />
        mastery ring
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'radial-gradient(circle, rgba(129,140,248,0.5), rgba(129,140,248,0))', display: 'inline-block' }} />
        hub nebula
      </span>
    </div>
  );
}

function SourceSelect({ sources, selectedSource, color, onChange }: {
  sources: SourceMeta[]; selectedSource: number | null; color: string; onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const current = sources.find(s => s.id === selectedSource);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          aria-label="Source to view on the constellation map"
          title="Choose which source's constellation to view (linked concepts from other sources are shown automatically)"
          style={{
            width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            border: '1px solid #263244', borderRadius: 4, padding: '6px 8px',
            color: '#e2e8f0', fontSize: 11, outline: 'none', cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} aria-hidden="true" />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {current?.filename ?? '(no source)'}
          </span>
          <span style={{ color: '#6b7280' }}>▾</span>
        </button>
        {open && (
          <div
            role="listbox"
            style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 30,
              background: 'rgba(13,13,22,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid #312e81', borderRadius: 6, maxHeight: 240, overflowY: 'auto',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: 4,
            }}
          >
            {sources.map(s => {
              const isSel = s.id === selectedSource;
              return (
                <button
                  key={s.id}
                  className="rel-opt"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { onChange(s.id); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                    background: isSel ? 'rgba(129,140,248,0.22)' : 'transparent',
                    border: 'none', borderRadius: 4, padding: '6px 8px',
                    color: isSel ? '#e0e7ff' : '#cbd5e1', fontSize: 11, cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.filename}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <span style={{ fontSize: 9, color: '#475569' }}>+ linked sources shown automatically</span>
    </div>
  );
}

function StatsFooter({ stats }: { stats: GraphStats }) {
  return (
    <div style={{
      padding: '5px 16px', borderTop: '1px solid rgba(31,41,55,0.72)',
      background: 'rgba(4,6,26,0.5)', fontSize: 10, color: '#64748b',
      display: 'flex', gap: 16, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
    }}>
      <span><span style={{ color: '#475569' }}>nodes</span> {stats.nodeCount}</span>
      <span><span style={{ color: '#475569' }}>edges</span> {stats.edgeCount}</span>
      <span><span style={{ color: '#475569' }}>dangling</span> {stats.danglingConstellations}</span>
      <span><span style={{ color: '#475569' }}>unresolved rel</span> {stats.unresolvedRelations}</span>
      <span><span style={{ color: '#475569' }}>dupes</span> {stats.duplicateEdges}</span>
      {stats.capped && <span style={{ color: '#f59e0b' }}>Showing highest-degree / highest-importance concepts.</span>}
    </div>
  );
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

interface Props {
  profile?: Profile;
  onConceptChanged?: () => void;
}

export default function ConstellationMap({ profile, onConceptChanged }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { graph, loading, sources, sourceColor, sourceName, selectedSource, setSelectedSource, view, hubs, conceptHubs, refreshHubs } = useConstellationGraph();
  const layout = useForceLayout(view, reducedMotion, conceptHubs);

  const [selected, setSelected] = useState<Concept | null>(null);
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{ x: number; y: number; text: string } | null>(null);
  const [showHubs, setShowHubs] = useState(true);
  const [focusedHub, setFocusedHub] = useState<number | null>(null);
  const [conceptQuery, setConceptQuery] = useState('');
  const [editHub, setEditHub] = useState<{ id: number; name: string; color: string; description: string } | null>(null);

  const openNode = useCallback(async (id: number) => {
    const c = await window.api.concepts.get(id);
    if (c) setSelected(c as Concept);
  }, []);
  const onHoverEnter = useCallback((id: number) => setHoverNode(id), []);
  const onHoverLeave = useCallback((id: number) => setHoverNode(h => (h === id ? null : h)), []);

  async function saveHubEdit() {
    if (!editHub || !editHub.name.trim()) return;
    await window.api.hubs.update({ id: editHub.id, name: editHub.name.trim(), color: editHub.color, description: editHub.description.trim() });
    setEditHub(null);
    refreshHubs();
  }
  async function deleteHub(id: number) {
    if (!window.confirm('Delete this hub? Concepts are kept; only the grouping is removed.')) return;
    await window.api.hubs.delete(id);
    if (focusedHub === id) setFocusedHub(null);
    if (editHub?.id === id) setEditHub(null);
    refreshHubs();
  }

  // A hub focus dims everything outside that hub's members (like hover, but
  // pinned). When the Hubs toggle is off, no dimming — show all star nodes.
  const focusSet = useMemo(() => {
    if (!showHubs || focusedHub == null) return null;
    const s = new Set<number>();
    for (const [cid, hs] of conceptHubs) if (hs.includes(focusedHub)) s.add(cid);
    return s;
  }, [showHubs, focusedHub, conceptHubs]);

  const neighbors = useMemo(() => {
    if (hoverNode == null) return null;
    const set = new Set<number>([hoverNode]);
    for (const e of view.edges) {
      if (e.a === hoverNode) set.add(e.b);
      if (e.b === hoverNode) set.add(e.a);
    }
    return set;
  }, [hoverNode, view]);

  const sim = layout.sim;
  const posById = useMemo(() => new Map(sim.map(s => [s.id, s])), [sim]);
  const showGraph = !loading && graph != null && view.nodes.length > 0;

  // Only surface hubs that actually have a member on the current (source-focused)
  // map — a hub whose concepts are all in other, hidden sources isn't actionable here.
  const visibleHubIds = useMemo(() => {
    const s = new Set<number>();
    for (const n of view.nodes) for (const hid of (conceptHubs.get(n.id) ?? [])) s.add(hid);
    return s;
  }, [view, conceptHubs]);

  const conceptList = useMemo(() => {
    const q = conceptQuery.trim().toLowerCase();
    return [...view.nodes]
      .filter(n => q === '' || n.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [view, conceptQuery]);

  // Footer stats scoped to the selected source: node/edge counts come from the
  // rendered view; data-health diagnostics from the per-source build tally.
  const footerStats = useMemo<GraphStats>(() => {
    const per = (selectedSource != null && graph) ? graph.statsBySource[selectedSource] : undefined;
    return {
      nodeCount: view.nodes.length,
      edgeCount: view.edges.length,
      danglingConstellations: per?.danglingConstellations ?? 0,
      unresolvedRelations: per?.unresolvedRelations ?? 0,
      duplicateEdges: per?.duplicateEdges ?? 0,
      capped: graph?.stats.capped ?? false,
    };
  }, [graph, selectedSource, view]);

  // Hub nebulae — recomputed each render so the clouds track the live layout.
  const clusters: Cluster[] = [];
  if (showHubs && hubs.length > 0) {
    const byHub = new Map<number, Array<{ x: number; y: number; r: number }>>();
    for (const node of sim) {
      const hs = conceptHubs.get(node.id);
      if (!hs) continue;
      const pt = { x: node.x, y: node.y, r: nodeRadius(node) };
      for (const h of hs) { const a = byHub.get(h) ?? []; a.push(pt); byHub.set(h, a); }
    }
    for (const h of hubs) {
      const pts = byHub.get(h.id);
      if (!pts || pts.length === 0) continue;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const radius = Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy) + p.r)) + 36;
      clusters.push({ id: h.id, name: h.name, color: h.color, cx, cy, radius, points: pts });
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative', zIndex: Z.graph }}>
      {sources.length > 0 && (
        <aside style={{ width: 240, flexShrink: 0, borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column', background: 'rgba(4,6,26,0.55)', minHeight: 0 }}>
          <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid #1f2937' }}>
            <SourceSelect sources={sources} selectedSource={selectedSource} color={sourceColor.get(selectedSource ?? -1) ?? '#94a3b8'} onChange={setSelectedSource} />
          </div>
          {hubs.length > 0 && (
            <div style={{ borderBottom: '1px solid #1f2937', padding: 8, maxHeight: '42%', overflowY: 'auto', flexShrink: 0 }}>
              <div style={{ fontSize: 9, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Hubs</div>
              {hubs.map(h => {
                // Show ALL hubs (not just ones on this source) so hubs whose
                // source was deleted are still editable/deletable. Dim off-view.
                const onView = visibleHubIds.has(h.id);
                return (
                <div key={h.id} className="cm-hub-chip" title={onView ? undefined : `${h.name} — not on this source`} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px', borderRadius: 6, opacity: onView ? 1 : 0.55, background: focusedHub === h.id ? 'rgba(129,140,248,0.14)' : 'transparent' }}>
                  <button onClick={() => setFocusedHub(f => (f === h.id ? null : h.id))} title={`Focus ${h.name} · ${h.member_count} concept${h.member_count === 1 ? '' : 's'}`}
                    style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: focusedHub === h.id ? '#e2e8f0' : '#cbd5e1', fontSize: 11, padding: 0, textAlign: 'left' }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: h.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                    <span style={{ fontSize: 9, color: '#64748b' }}>{h.member_count}</span>
                  </button>
                  <button className="cm-hub-action" onClick={() => setEditHub({ id: h.id, name: h.name, color: h.color, description: h.description ?? '' })} title={`Edit ${h.name}`} aria-label={`Edit hub ${h.name}`}
                    style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', padding: 2, display: 'inline-flex', borderRadius: 4 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  </button>
                  <button className="cm-hub-action cm-hub-del" onClick={() => void deleteHub(h.id)} title={`Delete ${h.name}`} aria-label={`Delete hub ${h.name}`}
                    style={{ background: 'transparent', border: 'none', color: '#475569', fontSize: 13, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', borderRadius: 4 }}>×</button>
                </div>
                );
              })}
              {focusedHub != null && (
                <button onClick={() => setFocusedHub(null)} style={{ marginTop: 6, width: '100%', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: 3, fontSize: 10, color: '#9ca3af', cursor: 'pointer' }}>Clear focus</button>
              )}
              {editHub && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input autoFocus value={editHub.name} onChange={e => setEditHub(h => (h ? { ...h, name: e.target.value } : h))}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void saveHubEdit(); } else if (e.key === 'Escape') setEditHub(null); }}
                      placeholder="Hub name" style={{ flex: 1, minWidth: 0, background: '#111827', border: '1px solid #263244', borderRadius: 4, padding: '5px 7px', color: '#e2e8f0', fontSize: 11, outline: 'none' }} />
                    <input type="color" value={editHub.color} onChange={e => setEditHub(h => (h ? { ...h, color: e.target.value } : h))}
                      aria-label="Hub color" title="Hub color" style={{ width: 28, height: 26, padding: 0, border: '1px solid #263244', borderRadius: 4, background: '#111827', cursor: 'pointer', flexShrink: 0 }} />
                  </div>
                  <input value={editHub.description} onChange={e => setEditHub(h => (h ? { ...h, description: e.target.value } : h))}
                    placeholder="Short description (optional)" style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: '5px 7px', color: '#cbd5e1', fontSize: 10, outline: 'none' }} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => void saveHubEdit()} disabled={!editHub.name.trim()}
                      style={{ flex: 1, background: editHub.name.trim() ? '#312e81' : '#111827', border: `1px solid ${editHub.name.trim() ? '#6366f1' : '#1f2937'}`, borderRadius: 4, padding: 5, color: editHub.name.trim() ? '#e0e7ff' : '#475569', fontSize: 11, fontWeight: 700, cursor: editHub.name.trim() ? 'pointer' : 'not-allowed' }}>Save</button>
                    <button onClick={() => setEditHub(null)} title="Cancel" aria-label="Cancel" style={{ width: 30, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: 5, color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #1f2937' }}>
            <input value={conceptQuery} onChange={e => setConceptQuery(e.target.value)} placeholder="Search concepts…"
              style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', border: '1px solid #263244', borderRadius: 4, padding: '6px 8px', color: '#e2e8f0', fontSize: 12, outline: 'none' }} />
          </div>
          <div className="concept-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {conceptList.length === 0 ? (
              <div style={{ padding: 16, fontSize: 11, color: '#475569', textAlign: 'center' }}>{view.nodes.length === 0 ? 'No concepts on this map.' : 'No matches.'}</div>
            ) : conceptList.map(n => {
              const isSel = selected?.id === n.id;
              return (
                <button key={n.id} className="rel-opt" onClick={() => void openNode(n.id)}
                  onMouseEnter={() => onHoverEnter(n.id)} onMouseLeave={() => onHoverLeave(n.id)} title={n.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: isSel ? 'rgba(129,140,248,0.18)' : 'transparent', border: 'none', borderLeft: `2px solid ${isSel ? (sourceColor.get(n.source_id) ?? '#374151') : 'transparent'}`, padding: '7px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(17,24,39,0.6)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sourceColor.get(n.source_id) ?? '#6b7280', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: isSel ? '#e2e8f0' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                </button>
              );
            })}
          </div>
        </aside>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid rgba(31,41,55,0.72)',
          background: 'rgba(4,6,26,0.4)', backdropFilter: 'blur(14px)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: '#6b7280' }}>drag · scroll to zoom · drag bg to pan</span>
          {hubs.length > 0 && (
            <button
              onClick={() => setShowHubs(v => !v)}
              title={showHubs ? 'Hide hub nebulae' : 'Show hub nebulae'}
              aria-pressed={showHubs}
              style={{ background: showHubs ? '#1e1b4b' : 'transparent', border: `1px solid ${showHubs ? '#6366f1' : '#1f2937'}`, borderRadius: 4, padding: '3px 9px', color: showHubs ? '#c7d2fe' : '#6b7280', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
            >
              Hubs
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: '#94a3b8' }}>
            <MapLegend />
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'radial-gradient(circle at 50% 40%, rgba(30,27,75,0.42), rgba(2,6,23,0.18))' }}>
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
          {showGraph && (() => {
            const ids = [...new Set(view.nodes.map(n => n.source_id))];
            return (
              <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 3, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', pointerEvents: 'none', maxWidth: 260 }}>
                {ids.map(id => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(4,6,26,0.5)', border: '1px solid #1f2937', borderRadius: 6, padding: '3px 8px', fontSize: 10, color: '#cbd5e1', backdropFilter: 'blur(6px)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sourceColor.get(id) ?? '#6b7280', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourceName.get(id) ?? `Source ${id}`}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          {showGraph && (
            <svg
              ref={layout.svgRef}
              width="100%" height="100%"
              role="application"
              aria-label="Constellation map of linked concepts"
              onMouseMove={layout.onSvgMouseMove}
              onMouseUp={layout.onSvgMouseUp}
              onMouseLeave={layout.onSvgMouseUp}
              onMouseDown={layout.onBackgroundMouseDown}
              onWheel={layout.onWheel}
              style={{ display: 'block', cursor: layout.panning ? 'grabbing' : 'default' }}
            >
              <MapDefs sources={sources} hubs={hubs} />
              <g className="cm-graph" transform={`translate(${layout.tx},${layout.ty}) scale(${layout.scale})`}>
                {showHubs && clusters.length > 0 && <NebulaLayer clusters={clusters} />}
                {view.edges.map((e, i) => {
                  const a = posById.get(e.a), b = posById.get(e.b);
                  if (!a || !b) return null;
                  const active = (neighbors == null || (neighbors.has(e.a) && neighbors.has(e.b)))
                    && (focusSet == null || (focusSet.has(e.a) && focusSet.has(e.b)));
                  const bidir = e.directed === false;
                  const crossSource = a.source_id !== b.source_id;
                  const tip = `${bidir ? 'mutual ↔' : 'one-way →'}${crossSource ? ' · cross-source' : ''}${e.label ? ' · ' + e.label : ''}`;
                  return (
                    <GraphEdgeLine
                      key={i}
                      ax={a.x} ay={a.y} bx={b.x} by={b.y}
                      ra={nodeRadius(a) + 1.5} rb={nodeRadius(b) + 1.5}
                      bidir={bidir} crossSource={crossSource} active={active}
                      tip={tip} midX={(a.x + b.x) / 2} midY={(a.y + b.y) / 2}
                      onHover={setHoverEdge}
                    />
                  );
                })}
                {sim.map(node => {
                  const stage = Math.max(0, Math.min(5, node.mastery_stage));
                  return (
                    <StarNode
                      key={node.id}
                      id={node.id} x={node.x} y={node.y} r={nodeRadius(node)} name={node.name}
                      stage={stage} sourceId={node.source_id}
                      sourceColor={sourceColor.get(node.source_id) ?? '#94a3b8'}
                      sourceName={sourceName.get(node.source_id) ?? ''}
                      dim={(neighbors != null && !neighbors.has(node.id)) || (focusSet != null && !focusSet.has(node.id))}
                      isHover={hoverNode === node.id}
                      isSel={selected?.id === node.id}
                      reducedMotion={reducedMotion}
                      onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave}
                      onDown={layout.beginNodeDrag} onOpen={openNode}
                    />
                  );
                })}
                {hoverEdge && <EdgeTooltip x={hoverEdge.x} y={hoverEdge.y} text={hoverEdge.text} />}
              </g>
            </svg>
          )}
        </div>

        {graph && <StatsFooter stats={footerStats} />}
      </div>

      {selected && (
        <div style={{ flex: '0 0 600px', maxWidth: '52%', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #1f2937', minWidth: 0, zIndex: Z.panelClose }}>
          {/* Dedicated close strip so this button never overlaps DetailPane's
              own header controls (e.g. the Source toggle). */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 8px 4px 12px', borderBottom: '1px solid rgba(31,41,55,0.72)', background: 'rgba(4,6,26,0.6)', flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>concept</span>
            <button
              onClick={() => setSelected(null)}
              title="Close concept detail"
              aria-label="Close concept detail"
              style={{ background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 4, color: '#c7d2fe', fontSize: 13, lineHeight: 1, padding: '3px 9px', cursor: 'pointer' }}
            >×</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <DetailPane
              concept={selected}
              profile={profile}
              onDeleted={() => { setSelected(null); onConceptChanged?.(); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
