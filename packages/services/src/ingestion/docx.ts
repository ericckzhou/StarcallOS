// DOCX → Markdown for the document importer. mammoth converts the .docx to
// clean semantic HTML (headings, lists, bold/italic preserved), which we run
// through the shared htmlToMarkdown so imported Word docs land in the same
// structured shape as URL imports. Runs in the main process only (it reads a
// file buffer). Title is derived by the caller from the filename.

import mammoth from 'mammoth';
import { htmlToMarkdown } from './html_text';

export async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });
  return htmlToMarkdown(result.value ?? '');
}
