import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { pptxToMarkdown } from './pptx';

// Build a minimal .pptx (a zip of slide XMLs) for the extractor to read.
function slideXml(paragraphs: string[]): string {
  const ps = paragraphs.map(p => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('');
  return `<p:sld><p:cSld><p:spTree>${ps}</p:spTree></p:cSld></p:sld>`;
}
function makePptx(named: Record<string, string>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, xml] of Object.entries(named)) files[name] = strToU8(xml);
  return Buffer.from(zipSync(files));
}
function fromSlides(slides: string[][]): Buffer {
  const named: Record<string, string> = {};
  slides.forEach((paras, i) => { named[`ppt/slides/slide${i + 1}.xml`] = slideXml(paras); });
  return makePptx(named);
}

describe('pptxToMarkdown', () => {
  it('emits one "## Slide N" section per slide with its text', () => {
    const md = pptxToMarkdown(fromSlides([['Title One', 'Bullet A'], ['Title Two']]));
    expect(md).toContain('## Slide 1');
    expect(md).toContain('Title One');
    expect(md).toContain('Bullet A');
    expect(md).toContain('## Slide 2');
    expect(md).toContain('Title Two');
  });

  it('keeps each paragraph on its own line', () => {
    const md = pptxToMarkdown(fromSlides([['Heading', 'point one', 'point two']]));
    expect(md).toContain('Heading\npoint one\npoint two');
  });

  it('decodes XML entities in slide text', () => {
    const md = pptxToMarkdown(fromSlides([['Tom &amp; Jerry &lt; 3']]));
    expect(md).toContain('Tom & Jerry < 3');
  });

  it('orders slides numerically, not lexically (slide10 after slide2)', () => {
    const buf = makePptx({
      'ppt/slides/slide2.xml': slideXml(['second slide text']),
      'ppt/slides/slide10.xml': slideXml(['tenth slide text']),
    });
    const md = pptxToMarkdown(buf);
    expect(md.indexOf('second slide text')).toBeLessThan(md.indexOf('tenth slide text'));
  });

  it('skips empty slides and returns empty string for no slides', () => {
    expect(pptxToMarkdown(fromSlides([[], ['Only this one']]))).not.toContain('## Slide 1');
    expect(pptxToMarkdown(makePptx({ 'ppt/presentation.xml': '<x/>' }))).toBe('');
  });
});
