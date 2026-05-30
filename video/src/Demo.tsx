import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { theme } from './theme';
import { ColdOpen, Problem, ClipScene, MasteryRamp, Payoff, CTA } from './scenes';

const T = 15; // transition length (frames)

/**
 * Product moments backed by REAL screenshots of the current UI. Drop the PNGs
 * into video/public/shots/ and flip `available: true` for each. Until then an
 * on-brand placeholder renders so the demo always previews/renders end-to-end.
 * See video/CAPTURE.md for the shot list.
 */
export const CLIPS = {
  import: { image: 'candidates.png', available: true, pan: 'down' as const, kicker: 'Step 01', label: 'Candidate Review — the deterministic candidate list', caption: 'Drop in any PDF. Candidates appear — $0, zero LLM.' },
  promote: { image: 'concept.png', available: true, pan: 'up' as const, kicker: 'Step 02', label: 'A promoted concept', caption: 'You promote what matters — grounded in the source.' },
  challenge: { image: 'challenge.png', available: true, pan: 'up' as const, kicker: 'Step 03', label: 'A Challenge + grader verdict', caption: 'Explain it. The grader says understood, gap, or connected.' },
  annotations: { image: 'annotation.png', available: true, pan: 'down' as const, kicker: 'Step 04', label: 'Annotations — highlights linked to notes & evidence', caption: 'Highlight as you read — notes link to the evidence.' },
} as const;

const SCENES: { node: React.ReactNode; dur: number }[] = [
  { node: <ColdOpen />, dur: 120 },
  { node: <Problem />, dur: 150 },
  { node: <ClipScene {...CLIPS.import} />, dur: 165 },
  { node: <ClipScene {...CLIPS.promote} />, dur: 165 },
  { node: <ClipScene {...CLIPS.challenge} />, dur: 195 },
  { node: <ClipScene {...CLIPS.annotations} />, dur: 165 },
  { node: <MasteryRamp />, dur: 120 },
  { node: <Payoff />, dur: 210 },
  { node: <CTA />, dur: 150 },
];

// Total = sum(durations) - (n-1) * transition length.
export const DEMO_DURATION =
  SCENES.reduce((a, s) => a + s.dur, 0) - (SCENES.length - 1) * T;

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bgDeep }}>
    <TransitionSeries>
      {SCENES.flatMap((s, i) => {
        const seq = (
          <TransitionSeries.Sequence key={`s-${i}`} durationInFrames={s.dur}>
            {s.node}
          </TransitionSeries.Sequence>
        );
        if (i === SCENES.length - 1) return [seq];
        return [
          seq,
          <TransitionSeries.Transition key={`t-${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: T })} />,
        ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
);

/**
 * Highlight reel for the README GIF: a quick pass through all four product
 * screenshots, then the constellation hero. Kept short per scene so the GIF
 * stays a reasonable file size while still showing the whole loop.
 */
const SHORT: { node: React.ReactNode; dur: number }[] = [
  { node: <ClipScene {...CLIPS.import} />, dur: 70 },
  { node: <ClipScene {...CLIPS.promote} />, dur: 70 },
  { node: <ClipScene {...CLIPS.challenge} />, dur: 70 },
  { node: <ClipScene {...CLIPS.annotations} />, dur: 70 },
  { node: <Payoff />, dur: 120 },
];
export const DEMO_SHORT_DURATION = SHORT.reduce((a, s) => a + s.dur, 0) - (SHORT.length - 1) * T;

export const DemoShort: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bgDeep }}>
    <TransitionSeries>
      {SHORT.flatMap((s, i) => {
        const seq = (
          <TransitionSeries.Sequence key={`s-${i}`} durationInFrames={s.dur}>
            {s.node}
          </TransitionSeries.Sequence>
        );
        if (i === SHORT.length - 1) return [seq];
        return [
          seq,
          <TransitionSeries.Transition key={`t-${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: T })} />,
        ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
);
