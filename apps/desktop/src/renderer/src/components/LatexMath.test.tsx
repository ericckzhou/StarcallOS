import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LatexMath from './LatexMath';

describe('LatexMath', () => {
  // Extracted equations sometimes carry an orphan closing brace. It must render
  // as a literal `}` rather than KaTeX's red error node. (The old assertion
  // expected `<sub>` tags from the removed homegrown parser — KaTeX emits
  // span-based markup, never `<sub>`, so that test could never pass.)
  it('renders an orphan closing brace as text, not a KaTeX error', () => {
    const html = renderToStaticMarkup(<LatexMath value="model_name}" />);

    expect(html).not.toContain('katex-error'); // KaTeX did not choke on the orphan brace
    expect(html).toContain('katex');           // it rendered real KaTeX markup
    expect(html).toContain('}');               // the orphan brace survives as a literal
  });

  it('leaves valid balanced LaTeX untouched', () => {
    const html = renderToStaticMarkup(<LatexMath value="x_{i}^{2}" />);
    expect(html).not.toContain('katex-error');
  });

  it('falls back to the raw text when KaTeX hard-fails (empty stays empty)', () => {
    const html = renderToStaticMarkup(<LatexMath value="" />);
    expect(html).not.toContain('katex-error');
  });
});
