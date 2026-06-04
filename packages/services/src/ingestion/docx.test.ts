import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { docxToMarkdown } from './docx';

// Build a minimal but mammoth-valid .docx (an OOXML zip) so the importer can be
// exercised end-to-end without a binary fixture on disk.
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function makeDocx(bodyXml: string): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
  }));
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe('docxToMarkdown', () => {
  it('converts paragraphs to markdown text', async () => {
    const md = await docxToMarkdown(makeDocx(para('First paragraph.') + para('Second paragraph.')));
    expect(md).toContain('First paragraph.');
    expect(md).toContain('Second paragraph.');
  });

  it('preserves bold runs as ** emphasis **', async () => {
    const boldPara = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>BoldWord</w:t></w:r></w:p>';
    const md = await docxToMarkdown(makeDocx(boldPara));
    expect(md).toContain('**BoldWord**');
  });

  it('decodes XML entities in the document text', async () => {
    const md = await docxToMarkdown(makeDocx(para('Tom &amp; Jerry &lt; 3')));
    expect(md).toContain('Tom & Jerry < 3');
  });

  it('returns an empty string for a document with no text', async () => {
    const md = await docxToMarkdown(makeDocx(''));
    expect(md).toBe('');
  });
});
