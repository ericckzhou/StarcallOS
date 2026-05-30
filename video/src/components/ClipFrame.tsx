import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from 'remotion';
import { theme, VIDEO } from '../theme';

/**
 * An app-window "screenshot frame" that holds the real current UI. Modes (by
 * precedence) when `available`:
 *   - `image` -> a real PNG screenshot (public/shots/<image>) with Ken-Burns pan
 *   - `src`   -> a real screen-capture clip (public/clips/<src>)
 * Otherwise it renders `children` (custom content) or an on-brand placeholder,
 * so the demo always renders end-to-end. Flip flags in Demo.tsx as media lands.
 */
export const ClipFrame: React.FC<{
  src?: string;
  image?: string;
  available?: boolean;
  label: string;
  zoom?: number;
  pan?: 'up' | 'down' | 'none';
  children?: React.ReactNode;
}> = ({ src, image, available = false, label, zoom = 1.06, pan = 'up', children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 22 });
  const scale = interpolate(frame, [0, VIDEO.fps * 6], [1, zoom]) * interpolate(enter, [0, 1], [0.96, 1]);
  const o = interpolate(enter, [0, 1], [0, 1]);

  const frameW = 1360;
  const frameH = 820;

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          width: frameW,
          height: frameH,
          transform: `scale(${scale})`,
          opacity: o,
          borderRadius: 16,
          overflow: 'hidden',
          border: `1px solid ${theme.panelBorder}`,
          boxShadow: '0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)',
          background: theme.bgDeep,
        }}
      >
        {/* title bar */}
        <div
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 14px',
            background: 'rgba(13,13,22,0.85)',
            borderBottom: `1px solid ${theme.panelBorder}`,
          }}
        >
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#ef4444' }} />
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#f59e0b' }} />
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#22c55e' }} />
          <span style={{ marginLeft: 12, fontFamily: theme.fontSans, fontSize: 14, color: theme.textMuted }}>
            StarcallOS
          </span>
        </div>

        <div style={{ width: '100%', height: frameH - 38, position: 'relative', background: theme.bg, overflow: 'hidden' }}>
          {available && image ? (
            <KenBurnsImg file={image} pan={pan} />
          ) : available && src ? (
            <OffthreadVideo src={staticFile(`clips/${src}`)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : children ? (
            children
          ) : (
            <Placeholder label={label} />
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A real screenshot with a slow Ken-Burns zoom + vertical pan. */
const KenBurnsImg: React.FC<{ file: string; pan: 'up' | 'down' | 'none' }> = ({ file, pan }) => {
  const frame = useCurrentFrame();
  const dur = VIDEO.fps * 8;
  const z = interpolate(frame, [0, dur], [1.04, 1.12], { extrapolateRight: 'clamp' });
  const shift = pan === 'none' ? 0 : interpolate(frame, [0, dur], [0, pan === 'up' ? -40 : 40], { extrapolateRight: 'clamp' });
  return (
    <Img
      src={staticFile(`shots/${file}`)}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        objectPosition: 'top center',
        transform: `scale(${z}) translateY(${shift}px)`,
      }}
    />
  );
};

const Placeholder: React.FC<{ label: string }> = ({ label }) => (
  <AbsoluteFill
    style={{
      justifyContent: 'center',
      alignItems: 'center',
      flexDirection: 'column',
      gap: 16,
      background:
        'repeating-linear-gradient(45deg, rgba(99,102,241,0.06) 0px, rgba(99,102,241,0.06) 18px, transparent 18px, transparent 36px)',
    }}
  >
    <div
      style={{
        fontFamily: theme.fontMono,
        fontSize: 18,
        letterSpacing: '0.25em',
        textTransform: 'uppercase',
        color: theme.indigoSoft,
        padding: '8px 16px',
        border: `1px dashed ${theme.panelBorder}`,
        borderRadius: 8,
      }}
    >
      clip placeholder
    </div>
    <div style={{ fontFamily: theme.fontSans, fontSize: 30, fontWeight: 700, color: theme.text, textAlign: 'center', maxWidth: 900 }}>
      {label}
    </div>
    <div style={{ fontFamily: theme.fontSans, fontSize: 18, color: theme.textFaint }}>
      drop the recording into <span style={{ color: theme.indigoSoft }}>video/public/clips/</span> and flip its flag in Demo.tsx
    </div>
  </AbsoluteFill>
);
