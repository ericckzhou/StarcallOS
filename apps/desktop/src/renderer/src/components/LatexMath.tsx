import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface Props {
  value: string;
  size?: number;
  color?: string;
  display?: boolean;
}

// Render a LaTeX string with KaTeX. Falls back to monospace raw text if KaTeX
// can't parse it (throwOnError:false already renders partial errors in red, so
// this catch is just for hard failures).
export default function LatexMath({ value, size = 13, color = '#fde68a', display = false }: Props) {
  const html = useMemo(() => {
    const src = (value ?? '').trim();
    if (!src) return '';
    try {
      return katex.renderToString(src, {
        throwOnError: false,
        displayMode: display,
        output: 'html',
      });
    } catch {
      return null;
    }
  }, [value, display]);

  if (html == null) {
    return (
      <span title={value} style={{ color, fontSize: size, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
        {value}
      </span>
    );
  }

  return (
    <span
      title={value}
      style={{ color, fontSize: size, lineHeight: 1.6, wordBreak: 'break-word', overflowWrap: 'anywhere' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
