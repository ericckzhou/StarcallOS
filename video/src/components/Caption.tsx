import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { theme } from '../theme';

/**
 * Lower-third caption card. Springs up + fades in at the start of its scene.
 * `kicker` is the small uppercase label (e.g. "STEP 01"); `title` is the line.
 */
export const Caption: React.FC<{
  title: string;
  kicker?: string;
  align?: 'left' | 'center';
  delay?: number;
}> = ({ title, kicker, align = 'left', delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 18 });
  const y = interpolate(enter, [0, 1], [40, 0]);
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div
      style={{
        position: 'absolute',
        left: align === 'center' ? 0 : 96,
        right: align === 'center' ? 0 : undefined,
        bottom: 110,
        textAlign: align,
        transform: `translateY(${y}px)`,
        opacity,
      }}
    >
      {kicker && (
        <div
          style={{
            fontFamily: theme.fontMono,
            fontSize: 22,
            letterSpacing: '0.35em',
            textTransform: 'uppercase',
            color: theme.indigoSoft,
            marginBottom: 14,
          }}
        >
          {kicker}
        </div>
      )}
      <div
        style={{
          fontFamily: theme.fontSans,
          fontSize: 58,
          fontWeight: 800,
          color: theme.text,
          lineHeight: 1.1,
          maxWidth: align === 'center' ? '100%' : 1100,
          textShadow: '0 4px 30px rgba(0,0,0,0.6)',
        }}
      >
        {title}
      </div>
    </div>
  );
};
