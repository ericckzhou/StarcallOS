import React, { useMemo } from 'react';
import { AbsoluteFill, random, useCurrentFrame, interpolate } from 'remotion';
import { theme, VIDEO } from '../theme';

type Star = { x: number; y: number; r: number; phase: number; speed: number; hue: string };

/**
 * Deterministic twinkling starfield with slow parallax drift. Seeded by `seed`
 * so renders are reproducible. Used as the background for synthetic scenes.
 */
export const Starfield: React.FC<{ count?: number; seed?: string; drift?: number }> = ({
  count = 140,
  seed = 'starcall',
  drift = 18,
}) => {
  const frame = useCurrentFrame();
  const stars = useMemo<Star[]>(() => {
    const palette = [theme.indigoSoft, theme.indigoFaint, '#ffffff', theme.indigo];
    return new Array(count).fill(0).map((_, i) => ({
      x: random(`${seed}-x-${i}`) * VIDEO.width,
      y: random(`${seed}-y-${i}`) * VIDEO.height,
      r: 0.6 + random(`${seed}-r-${i}`) * 2.2,
      phase: random(`${seed}-p-${i}`) * Math.PI * 2,
      speed: 0.5 + random(`${seed}-s-${i}`) * 1.5,
      hue: palette[Math.floor(random(`${seed}-h-${i}`) * palette.length)],
    }));
  }, [count, seed]);

  const driftY = interpolate(frame, [0, VIDEO.fps * 12], [0, drift]);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 35%, ${theme.bg} 0%, ${theme.bgDeep} 70%)` }}>
      <svg width={VIDEO.width} height={VIDEO.height} style={{ position: 'absolute', inset: 0 }}>
        {stars.map((s, i) => {
          const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(frame * 0.06 * s.speed + s.phase));
          return (
            <circle
              key={i}
              cx={s.x}
              cy={(s.y + driftY) % VIDEO.height}
              r={s.r}
              fill={s.hue}
              opacity={twinkle * 0.9}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
