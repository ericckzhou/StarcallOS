import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface Props {
  value: string;
  size?: number;
  color?: string;
  display?: boolean;
}

// Extracted equation text often carries stray braces (an orphan `}` left by a
// bad split, or an unclosed `{`). KaTeX treats those as parse errors and renders
// an ugly red `katex-error` span. Escape any unmatched brace to its literal
// (`\{` / `\}`) so the rest of the expression still renders. Balanced braces are
// left untouched, so valid LaTeX is unaffected.
function escapeOrphanBraces(s: string): string {
  const orphan = new Set<number>();
  const opens: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }            // skip an escaped char (e.g. \{ \})
    if (c === '{') opens.push(i);
    else if (c === '}') { if (opens.length) opens.pop(); else orphan.add(i); }
  }
  for (const i of opens) orphan.add(i);           // any '{' left unclosed
  if (orphan.size === 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) out += (orphan.has(i) ? '\\' : '') + s[i];
  return out;
}

// Render a LaTeX string with KaTeX. Falls back to monospace raw text if KaTeX
// can't parse it (throwOnError:false already renders partial errors in red, so
// this catch is just for hard failures).
export default function LatexMath({ value, size = 13, color = '#fde68a', display = false }: Props) {
  const html = useMemo(() => {
    const src = escapeOrphanBraces((value ?? '').trim());
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
