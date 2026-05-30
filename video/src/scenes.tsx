import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { theme } from './theme';
import { Starfield } from './components/Starfield';
import { Wordmark } from './components/Wordmark';
import { Caption } from './components/Caption';
import { ClipFrame } from './components/ClipFrame';
import { ConstellationMap } from './components/ConstellationMap';
import { Logo } from './components/Logo';

export const ColdOpen: React.FC = () => (
  <AbsoluteFill>
    <Starfield count={180} seed="open" />
    <Wordmark />
  </AbsoluteFill>
);

export const Problem: React.FC = () => (
  <AbsoluteFill>
    <Starfield count={90} seed="problem" />
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 220px' }}>
      <div
        style={{
          fontFamily: theme.fontSans,
          fontSize: 64,
          fontWeight: 800,
          color: theme.text,
          textAlign: 'center',
          lineHeight: 1.2,
        }}
      >
        You highlight a chapter and feel like you got it.
        <br />
        <span style={{ color: theme.indigoSoft }}>A week later, you can&apos;t explain it.</span>
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);

/**
 * Generic "product moment" scene: the app-window frame + a lower-third caption.
 * By default it renders the synthetic `mock` UI inside the window. If a real
 * screen-capture clip is later dropped in (available + src), the frame shows the
 * video instead — see ClipFrame.
 */
export const ClipScene: React.FC<{
  src?: string;
  image?: string;
  available?: boolean;
  label: string;
  kicker: string;
  caption: string;
  zoom?: number;
  pan?: 'up' | 'down' | 'none';
}> = ({ src, image, available, label, kicker, caption, zoom, pan }) => (
  <AbsoluteFill>
    <Starfield count={60} seed={`bg-${kicker}`} drift={8} />
    <ClipFrame src={src} image={image} available={available} label={label} zoom={zoom} pan={pan} />
    <Caption kicker={kicker} title={caption} />
  </AbsoluteFill>
);

const STAGES = ['Unseen', 'Memorized', 'Can Explain', 'Connected', 'Compressed', 'Predicts Failures'];

/** Synthetic mastery-stage ladder lighting up left-to-right. */
export const MasteryRamp: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Starfield count={70} seed="mastery" drift={6} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 40 }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {STAGES.map((s, i) => {
            const sp = spring({ frame: frame - 10 - i * 10, fps, config: { damping: 200 }, durationInFrames: 14 });
            const color = theme.mastery[i];
            return (
              <React.Fragment key={s}>
                <div
                  style={{
                    transform: `scale(${interpolate(sp, [0, 1], [0.8, 1])})`,
                    opacity: sp,
                    padding: '14px 22px',
                    borderRadius: 999,
                    border: `2px solid ${color}`,
                    background: `${color}22`,
                    color: theme.text,
                    fontFamily: theme.fontSans,
                    fontSize: 26,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    boxShadow: `0 0 24px ${color}55`,
                  }}
                >
                  {s}
                </div>
                {i < STAGES.length - 1 && (
                  <div style={{ width: 30, height: 2, background: theme.indigoSoft, opacity: sp }} />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </AbsoluteFill>
      <Caption kicker="Mastery climbs" title="Each survived challenge moves a concept up a stage." align="center" />
    </AbsoluteFill>
  );
};

export const Payoff: React.FC = () => (
  <AbsoluteFill>
    <ConstellationMap seed="payoff" />
    <Caption kicker="Your sky of concepts" title="Stars are concepts. Lines are how they connect." align="center" />
  </AbsoluteFill>
);

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 6, fps, config: { damping: 200 }, durationInFrames: 20 });
  return (
    <AbsoluteFill>
      <Starfield count={150} seed="cta" />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 26 }}>
        <div style={{ opacity: s, transform: `translateY(${interpolate(s, [0, 1], [30, 0])}px)`, marginBottom: 4 }}>
          <Logo size={150} />
        </div>
        <div
          style={{
            transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px)`,
            opacity: s,
            fontFamily: theme.fontSans,
            fontSize: 96,
            fontWeight: 900,
            color: theme.text,
            textShadow: '0 0 50px rgba(99,102,241,0.5)',
          }}
        >
          Starcall<span style={{ color: theme.indigoSoft }}>OS</span>
        </div>
        <div style={{ opacity: interpolate(frame, [18, 32], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), fontFamily: theme.fontSans, fontSize: 36, color: theme.textMuted }}>
          Free · Local-first · Zero-LLM extraction · Any subject
        </div>
        <div
          style={{
            marginTop: 18,
            opacity: interpolate(frame, [30, 44], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            fontFamily: theme.fontMono,
            fontSize: 30,
            color: theme.indigoFaint,
            padding: '12px 26px',
            border: `1px solid ${theme.panelBorder}`,
            borderRadius: 12,
            background: theme.panel,
          }}
        >
          github.com/ericckzhou/StarcallOS
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
