import React from 'react';
import { useCurrentFrame, interpolate } from 'remotion';
import { theme } from '../theme';

/** Build a sharp N-point sparkle path centered at (0,0). */
function sparklePath(points: number, R: number, r: number): string {
  const segs: string[] = [];
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + i * step;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    segs.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return segs.join(' ') + ' Z';
}

/**
 * The StarcallOS mark: a bright 4-point "call star" with a soft glow and a thin
 * tilted orbit ring carrying a small dot. `animated` adds twinkle + orbit motion
 * for the video; pass `animated={false}` for the static app-icon render.
 */
export const Logo: React.FC<{ size?: number; animated?: boolean; tile?: boolean }> = ({
  size = 220,
  animated = true,
  tile = false,
}) => {
  const frame = useCurrentFrame();
  const vb = 100;
  const c = vb / 2;

  const twinkle = animated ? 0.82 + 0.18 * Math.sin(frame * 0.12) : 1;
  const orbitAngle = animated ? (frame * 1.6) % 360 : -52;
  const enter = animated ? interpolate(frame, [0, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;

  const star = sparklePath(4, 34 * enter, 7 * enter);
  const orbitRx = 44;
  const orbitRy = 18;
  const rad = (orbitAngle * Math.PI) / 180;
  const dotX = c + Math.cos(rad) * orbitRx;
  const dotY = c + Math.sin(rad) * orbitRy;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`}>
      <defs>
        <radialGradient id="lg-glow">
          <stop offset="0%" stopColor={theme.indigoSoft} stopOpacity={0.9} />
          <stop offset="45%" stopColor={theme.indigo} stopOpacity={0.35} />
          <stop offset="100%" stopColor={theme.indigo} stopOpacity={0} />
        </radialGradient>
        <linearGradient id="lg-star" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor={theme.indigoFaint} />
        </linearGradient>
        <radialGradient id="lg-tile" cx="35%" cy="28%">
          <stop offset="0%" stopColor="#1a1a3a" />
          <stop offset="100%" stopColor={theme.bgDeep} />
        </radialGradient>
      </defs>

      {tile && <rect x="0" y="0" width={vb} height={vb} rx={22} fill="url(#lg-tile)" />}

      {/* glow */}
      <circle cx={c} cy={c} r={42 * twinkle} fill="url(#lg-glow)" />

      {/* orbit ring (tilted) */}
      <g transform={`rotate(-18 ${c} ${c})`}>
        <ellipse cx={c} cy={c} rx={orbitRx} ry={orbitRy} fill="none" stroke={theme.indigoSoft} strokeOpacity={0.55} strokeWidth={1.4} />
        <circle cx={dotX} cy={dotY} r={3.4} fill={theme.indigoFaint} />
      </g>

      {/* call star */}
      <g transform={`translate(${c} ${c})`}>
        <path d={star} fill="url(#lg-star)" />
        <circle cx={0} cy={0} r={2.4} fill="#ffffff" />
      </g>
    </svg>
  );
};
