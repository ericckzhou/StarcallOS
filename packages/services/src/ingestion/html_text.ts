// Lightweight, zero-dependency HTML → readable text for the URL importer. This
// is intentionally not a full DOM parser: it strips the obvious non-content
// elements (script/style/head/nav/etc.), removes the remaining tags, decodes
// the common HTML entities, and collapses whitespace. Good enough for most
// articles; messy SPA pages will yield thinner text. Pure and string-only so it
// unit-tests without a network or a DOM — the actual fetch lives in main.

export interface ExtractedHtml {
  title?: string;
  text: string;
}

// Named entities worth decoding by hand; everything numeric is handled below.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', cent: '¢',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// Extract <title> (preferred) or the first <h1> as the source title.
function extractTitle(html: string): string | undefined {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const pick = (title ?? h1 ?? '');
  const clean = decodeEntities(pick.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

export function htmlToText(html: string): ExtractedHtml {
  const title = extractTitle(html);

  let body = html;
  // Drop wholesale non-content regions (including their inner text).
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<(script|style|head|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Turn block-level boundaries into newlines so paragraphs survive tag removal.
  body = body.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote)\s*>/gi, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<li\b[^>]*>/gi, '\n• ');
  // Strip every remaining tag, decode entities, normalize whitespace.
  body = body.replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);
  body = body
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: body };
}

// HTML → lightweight Markdown, preserving the structure the flat text view
// throws away: headings (#), list items (-), block paragraphs, and bold/italic.
// Used on Readability's cleaned article HTML so the imported source keeps its
// shape. Still zero-dependency and string-only.
export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|head|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Headings → #-prefixed lines (level clamped to h1–h6).
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text ? `\n\n${'#'.repeat(Number(lvl))} ${text}\n\n` : '\n\n';
  });
  // Emphasis → ** / *  (run before generic tag stripping).
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return t ? `**${t}**` : '';
  });
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return t ? `*${t}*` : '';
  });
  // List items → "- " bullets.
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li\s*>/gi, '\n');
  // Block boundaries → blank lines.
  s = s.replace(/<\/(p|div|section|article|header|footer|tr|blockquote|ul|ol)\s*>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');

  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
  return s;
}
