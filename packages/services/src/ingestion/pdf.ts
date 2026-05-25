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

export async function parsePdf(filePath: string): Promise<ParsedPdf> {
  const buffer = fs.readFileSync(filePath);

  const pages: PageText[] = [];

  const options = {
    pagerender(pageData: {
      pageIndex: number;
      getTextContent: () => Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }>;
    }): Promise<string> {
      return pageData.getTextContent().then(content => {
        const text = content.items
          .map(item => item.str + (item.hasEOL ? '\n' : ' '))
          .join('')
          .trim();
        pages.push({ page: pageData.pageIndex + 1, text });
        return text;
      });
    },
  };

  const result = await pdfParse(buffer, options);

  // Fallback: if pagerender didn't fire, split on form-feed characters
  if (pages.length === 0) {
    result.text.split(/\f/).filter(Boolean).forEach((text: string, i: number) =>
      pages.push({ page: i + 1, text: text.trim() }),
    );
  }

  return {
    page_count: result.numpages,
    pages,
    full_text: result.text,
  };
}
