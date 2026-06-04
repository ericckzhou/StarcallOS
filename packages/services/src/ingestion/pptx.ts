// PPTX → Markdown for the document importer. A .pptx is a zip; we unzip it
// (fflate), read each slide's XML in order, and pull the text runs (`<a:t>`)
// grouped by paragraph (`<a:p>`) so bullets/titles stay on their own lines.
// Each slide becomes a `## Slide N` section. Tables, speaker notes, and exotic
// layouts are not extracted — good enough for learning content. Runs in main
// (reads a file buffer); the caller derives the title from the filename.

import { unzipSync, strFromU8 } from 'fflate';

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeCp(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so we don't double-decode
}

function safeCp(code: number): string {
  try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

function slideIndex(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

// Pull each paragraph's joined text runs from a slide's XML, dropping empties.
function slideParagraphs(xml: string): string[] {
  const paras = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
  return paras
    .map(p => {
      const runs = [...p.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeXml(m[1]));
      return runs.join('').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

export function pptxToMarkdown(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  const slides = Object.keys(files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  const blocks: string[] = [];
  slides.forEach((name, i) => {
    const paras = slideParagraphs(strFromU8(files[name]));
    if (paras.length > 0) blocks.push(`## Slide ${i + 1}\n\n${paras.join('\n')}`);
  });
  return blocks.join('\n\n').trim();
}
