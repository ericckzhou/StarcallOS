import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LatexMath from './LatexMath';

describe('LatexMath', () => {
  it('keeps orphan closing braces after bare scripts at script size', () => {
    const html = renderToStaticMarkup(<LatexMath value="model_name}" />);

    expect(html).toContain('<sub');
    expect(html).toMatch(/<sub[^>]*>.*name.*}.*<\/sub>/);
    expect(html).not.toMatch(/<\/sub><span[^>]*>}<\/span>/);
  });
});
