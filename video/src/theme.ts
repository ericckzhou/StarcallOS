// Brand tokens mirrored from the StarcallOS desktop UI (deep-space + indigo).
export const theme = {
  bg: '#0a0a14',
  bgDeep: '#06060d',
  panel: 'rgba(13,13,22,0.55)',
  panelBorder: 'rgba(99,102,241,0.35)',
  indigo: '#6366f1',
  indigoSoft: '#a5b4fc',
  indigoFaint: '#c7d2fe',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#64748b',
  // Mastery ramp (Unseen -> Compressed), used for constellation node colors.
  mastery: ['#475569', '#f59e0b', '#fb923c', '#facc15', '#a3e635', '#22c55e'],
  fontSans:
    "Inter, 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  fontMono:
    "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
} as const;

export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;
