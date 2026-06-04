// Article extraction for the URL importer. Uses Mozilla's Readability (the
// engine behind Firefox Reader View) over a lightweight linkedom DOM to isolate
// the article body — dropping nav, headers, footers, share bars, and sign-up
// chrome that the plain tag-stripper would otherwise turn into candidates.
//
// Readability runs in the main process only (it needs a DOM). If it throws or
// finds no article (paywalls, SPA shells, odd markup), we fall back to the
// zero-dependency htmlToText so a page never yields an empty source.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { htmlToText, type ExtractedHtml } from './html_text';

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractArticle(html: string): ExtractedHtml {
  try {
    const { document } = parseHTML(html);
    // Readability mutates the document in place; that's fine, it's throwaway.
    const article = new Readability(document as unknown as Document).parse();
    const text = normalizeText(article?.textContent ?? '');
    if (text) {
      const title = article?.title?.trim();
      return { title: title || undefined, text };
    }
  } catch {
    // Fall through to the plain stripper below.
  }
  return htmlToText(html);
}
