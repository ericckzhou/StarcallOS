import fs from 'fs';
/* eslint-disable @typescript-eslint/no-require-imports */
const pdfParse = require('pdf-parse') as (
  data: Buffer,
  options?: Record<string, unknown>,
) => Promise<{ numpages: number; text: string }>;

export interface PageText {
  page: number;
  text: string;
}

export interface ParsedPdf {
  page_count: number;
  pages: PageText[];
  full_text: string;
}

// Exported for unit testing.
export function pageTextFromItems(
  items: Array<{ str: string; hasEOL?: boolean }>,
  pageIndex: number,
): PageText {
  const text = items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
  return { page: pageIndex + 1, text };
}

// Exported for unit testing.
export function pagesFromFormFeeds(fullText: string): PageText[] {
  return fullText.split(/\f/).filter(Boolean).map((text, i) => ({ page: i + 1, text: text.trim() }));
}

export async function parsePdf(filePath: string): Promise<ParsedPdf> {
  const buffer = fs.readFileSync(filePath);
  const pages: PageText[] = [];

  const options = {
    pagerender(pageData: {
      pageIndex: number;
      getTextContent: () => Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }>;
    }): Promise<string> {
      return pageData.getTextContent().then(content => {
        const p = pageTextFromItems(content.items, pageData.pageIndex);
        pages.push(p);
        return p.text;
      });
    },
  };

  const result = await pdfParse(buffer, options);

  if (pages.length === 0) {
    pages.push(...pagesFromFormFeeds(result.text));
  }

  return { page_count: result.numpages, pages, full_text: result.text };
}
