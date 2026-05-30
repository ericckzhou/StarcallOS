import React, { useMemo } from 'react';
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { theme, VIDEO } from '../theme';

type Node = { id: number; x: number; y: number; r: number; mastery: number; hub: number };
type Edge = { a: number; b: number; cross: boolean };

/**
 * The brand money-shot: a force-directed-looking constellation of concept
 * "stars" that pop in one by one, with edges drawing between them and soft
 * nebula clusters (hubs) glowing behind. Synthetic but on-brand; doubles as the
 * fallback for the real Map if footage isn't captured.
 */
export const ConstellationMap: React.FC<{ seed?: string }> = ({ seed = 'map' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { nodes, edges, hubs } = useMemo(() => {
    const N = 26;
    const cx = VIDEO.width / 2;
    const cy = VIDEO.height / 2;
    const hubCenters = [
      { x: cx - 380, y: cy - 120, color: theme.indigo },
      { x: cx + 360, y: cy + 60, color: '#8b5cf6' },
      { x: cx + 120, y: cy - 260, color: '#ec4899' },
    ];
    const nodes: Node[] = new Array(N).fill(0).map((_, i) => {
      const hub = Math.floor(random(`${seed}-hub-${i}`) * hubCenters.length);
      const ang = random(`${seed}-a-${i}`) * Math.PI * 2;
      const rad = 60 + random(`${seed}-rad-${i}`) * 230;
      return {
        id: i,
        x: hubCenters[hub].x + Math.cos(ang) * rad,
        y: hubCenters[hub].y + Math.sin(ang) * rad * 0.8,
        r: 4 + random(`${seed}-r-${i}`) * 7,
        mastery: Math.floor(random(`${seed}-m-${i}`) * theme.mastery.length),
        hub,
      };
    });
    const edges: Edge[] = [];
    for (let i = 0; i < N; i++) {
      const links = 1 + Math.floor(random(`${seed}-deg-${i}`) * 2);
      for (let k = 0; k < links; k++) {
        const j = Math.floor(random(`${seed}-e-${i}-${k}`) * N);
        if (j !== i) edges.push({ a: i, b: j, cross: nodes[i].hub !== nodes[j].hub });
      }
    }
    return { nodes, edges, hubs: hubCenters };
  }, [seed]);

  // Slow global rotation/breathing for life.
  const rot = interpolate(frame, [0, VIDEO.fps * 10], [-1.5, 1.5]);
  const breathe = 1 + 0.015 * Math.sin(frame * 0.03);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, ${theme.bg} 0%, ${theme.bgDeep} 75%)` }}>
      <svg
        width={VIDEO.width}
        height={VIDEO.height}
        style={{ position: 'absolute', inset: 0, transform: `rotate(${rot}deg) scale(${breathe})`, transformOrigin: 'center' }}
      >
        <defs>
          {hubs.map((h, i) => (
            <radialGradient key={i} id={`neb-${i}`}>
              <stop offset="0%" stopColor={h.color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={h.color} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>

        {/* Nebula clusters (hubs) */}
        {hubs.map((h, i) => {
          const o = interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return <circle key={i} cx={h.x} cy={h.y} r={300} fill={`url(#neb-${i})`} opacity={o} />;
        })}

        {/* Edges draw in after nodes begin appearing */}
        {edges.map((e, i) => {
          const na = nodes[e.a];
          const nb = nodes[e.b];
          const start = 18 + Math.max(e.a, e.b) * 2.4;
          const p = interpolate(frame, [start, start + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const x2 = na.x + (nb.x - na.x) * p;
          const y2 = na.y + (nb.y - na.y) * p;
          return (
            <line
              key={i}
              x1={na.x}
              y1={na.y}
              x2={x2}
              y2={y2}
              stroke={e.cross ? theme.indigoSoft : 'rgba(99,102,241,0.45)'}
              strokeWidth={e.cross ? 1.6 : 1}
              strokeDasharray={e.cross ? '4 6' : undefined}
              opacity={0.55 * p}
            />
          );
        })}

        {/* Concept stars pop in one by one */}
        {nodes.map((n) => {
          const s = spring({ frame: frame - (10 + n.id * 2.4), fps, config: { damping: 120 }, durationInFrames: 16 });
          const glow = 0.6 + 0.4 * Math.sin(frame * 0.08 + n.id);
          const color = theme.mastery[n.mastery];
          return (
            <g key={n.id} opacity={s}>
              <circle cx={n.x} cy={n.y} r={n.r * 2.6 * s} fill={color} opacity={0.18 * glow} />
              <circle cx={n.x} cy={n.y} r={n.r * s} fill={color} />
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
