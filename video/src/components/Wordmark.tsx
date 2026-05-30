import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { theme } from '../theme';
import { Logo } from './Logo';

/** Animated StarcallOS wordmark + tagline for the cold open. */
export const Wordmark: React.FC<{ tagline?: string }> = ({
  tagline = 'Claims of understanding need evidence.',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const word = 'StarcallOS';
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ marginBottom: 18, opacity: interpolate(frame, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <Logo size={200} />
      </div>
      <div style={{ display: 'flex' }}>
        {word.split('').map((ch, i) => {
          const s = spring({ frame: frame - i * 2, fps, config: { damping: 200 }, durationInFrames: 20 });
          const y = interpolate(s, [0, 1], [60, 0]);
          const o = interpolate(s, [0, 1], [0, 1]);
          return (
            <span
              key={i}
              style={{
                fontFamily: theme.fontSans,
                fontSize: 120,
                fontWeight: 900,
                letterSpacing: '-0.02em',
                color: i < 8 ? theme.text : theme.indigoSoft,
                transform: `translateY(${y}px)`,
                opacity: o,
                textShadow: '0 0 40px rgba(99,102,241,0.45)',
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 28,
          fontFamily: theme.fontSans,
          fontSize: 34,
          fontWeight: 500,
          color: theme.textMuted,
          opacity: interpolate(frame, [26, 42], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          fontStyle: 'italic',
        }}
      >
        {tagline}
      </div>
    </AbsoluteFill>
  );
};
