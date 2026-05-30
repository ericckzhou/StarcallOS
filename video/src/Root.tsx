import React from 'react';
import { AbsoluteFill, Composition } from 'remotion';
import { VIDEO } from './theme';
import { Demo, DemoShort, DEMO_DURATION, DEMO_SHORT_DURATION } from './Demo';
import { Payoff } from './scenes';
import { Logo } from './components/Logo';

// Static app-icon tile (rendered to PNG -> .ico for electron-builder).
const IconTile: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', background: 'transparent' }}>
    <Logo size={512} animated={false} tile />
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Icon" component={IconTile} durationInFrames={1} fps={1} width={512} height={512} />
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={DEMO_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    <Composition
      id="DemoShort"
      component={DemoShort}
      durationInFrames={DEMO_SHORT_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    {/* Standalone still for thumbnails / social cards. */}
    <Composition
      id="Payoff"
      component={Payoff}
      durationInFrames={210}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  </>
);
