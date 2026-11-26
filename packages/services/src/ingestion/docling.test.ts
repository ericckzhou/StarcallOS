import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedDoclingDocument, convertPdfWithDocling, doclingToSegmentation, headingDepthFromNumbering,
  type DoclingDocument,
} from './docling';

// Synthetic DoclingDocument shaped like real docling-serve 1.40 output
// (schema 1.x): body tree with refs, furniture page headers, a group, a
// formula whose text lives only in `orig`, a table, and a nested list.
const prov = (page: number, t = 700) => [{ page_no: page, bbox: { l: 72, t, r: 540, b: t - 20, coord_origin: 'BOTTOMLEFT' } }];
function fixture(): DoclingDocument {
  return {
    schema_name: 'DoclingDocument',
    version: '1.10.0',
    body: { self_ref: '#/body', label: 'unspecified', children: [
      { $ref: '#/texts/0' }, { $ref: '#/texts/1' }, { $ref: '#/texts/2' }, { $ref: '#/groups/0' },
      { $ref: '#/texts/5' }, { $ref: '#/tables/0' }, { $ref: '#/texts/6' }, { $ref: '#/texts/7' },
    ] },
    groups: [{ self_ref: '#/groups/0', label: 'list', content_layer: 'body', children: [{ $ref: '#/texts/3' }, { $ref: '#/texts/4' }] }],
    texts: [
      { self_ref: '#/texts/0', label: 'page_header', content_layer: 'furniture', text: 'CHAPTER 2. GRAPHS', prov: prov(3, 780) },
      { self_ref: '#/texts/1', label: 'section_header', content_layer: 'body', level: 1, text: '2.3 Spanning trees', prov: prov(3) },
      { self_ref: '#/texts/2', label: 'text', content_layer: 'body', text: 'A spanning tree   of a graph\ncontains every vertex.', prov: prov(3, 650) },
      { self_ref: '#/texts/3', label: 'list_item', content_layer: 'body', text: 'it is connected', prov: prov(3, 600) },
      { self_ref: '#/texts/4', label: 'list_item', content_layer: 'body', text: 'it has no cycles', prov: prov(3, 580) },
      { self_ref: '#/texts/5', label: 'formula', content_layer: 'body', text: '', orig: '|E| = |V| - 1', prov: prov(4) },
      { self_ref: '#/texts/6', label: 'section_header', content_layer: 'body', level: 1, text: 'Exercises', prov: prov(5) },
      { self_ref: '#/texts/7', label: 'page_footer', content_layer: 'furniture', text: '17', prov: prov(5, 40) },
    ],
    tables: [{
      self_ref: '#/tables/0', label: 'table', content_layer: 'body', prov: prov(4, 500),
      data: { grid: [[{ text: 'n' }, { text: 'edges' }], [{ text: '4' }, { text: '3' }]] },
    }],
    pictures: [],
    pages: { '3': { size: { width: 612, height: 792 } }, '4': { size: { width: 612, height: 792 } }, '5': { size: { width: 612, height: 792 } } },
  };
}

describe('headingDepthFromNumbering', () => {
  it('reads depth from section numbering', () => {
    expect(headingDepthFromNumbering('6.8 Logical implication')).toBe(2);
    expect(headingDepthFromNumbering('7 Finite automata')).toBe(1);
    expect(headingDepthFromNumbering('Chapter 7 Finite automata')).toBe(1);
    expect(headingDepthFromNumbering('1.2.3.4.5 Deep')).toBe(4);
    expect(headingDepthFromNumbering('Exercises')).toBeNull();
    expect(headingDepthFromNumbering('3.5')).toBeNull();
  });
});

describe('doclingToSegmentation', () => {
  it('maps labels to blocks in reading order and drops furniture', () => {
    const r = doclingToSegmentation(fixture());
    expect(r.blocks.map(b => [b.page, b.hint, b.text])).toEqual([
      [3, 'subheading', '2.3 Spanning trees'],
      [3, 'body', 'A spanning tree of a graph contains every vertex.'],
      [3, 'list_item', 'it is connected'],
      [3, 'list_item', 'it has no cycles'],
      [4, 'formula', '|E| = |V| - 1'],
      [4, 'body', 'n | edges 4 | 3'],
      [5, 'subheading', 'Exercises'],
    ]);
    expect(r.blocks.map(b => b.readingOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.pageCount).toBe(3);
    expect(r.runningHeaderSections).toEqual([]);
    expect(r.diagnostics).toMatchObject({ repeating_header_stripped: 2, heading_block_count: 2, formula_block_count: 1, pages_with_text: 3 });
  });

  it('gives headings heading-like typography and depth', () => {
    const [h, body] = doclingToSegmentation(fixture()).blocks;
    expect(h.signals).toMatchObject({ headingDepth: 2, isBold: true, isIsolatedLine: true });
    expect(h.signals.fontSizeRatio).toBeGreaterThan(1.15);
    expect(body.signals).toMatchObject({ fontSizeRatio: 1, isBold: false });
    expect(h.signals.pageTopRatio).toBeCloseTo(700 / 792, 3);
  });

  it('drops running headers mislabelled as headings and folds "Chapter N" into its title', () => {
    const d = fixture();
    d.texts!.push(
      { self_ref: '#/texts/8', label: 'section_header', content_layer: 'body', text: '18 CHAPTER 2. GRAPHS', prov: prov(6, 780) },
      { self_ref: '#/texts/9', label: 'section_header', content_layer: 'body', text: 'Chapter 3', prov: prov(7) },
      { self_ref: '#/texts/10', label: 'section_header', content_layer: 'body', text: 'TREES', prov: prov(7, 680) },
      { self_ref: '#/texts/11', label: 'section_header', content_layer: 'body', text: '3.1 Rooted trees', prov: prov(7, 640) },
      // Running header = the section title (common): the real heading must survive.
      { self_ref: '#/texts/12', label: 'page_header', content_layer: 'furniture', text: '3.1. ROOTED TREES', prov: prov(8, 780) },
    );
    d.body.children!.push({ $ref: '#/texts/8' }, { $ref: '#/texts/9' }, { $ref: '#/texts/10' }, { $ref: '#/texts/11' }, { $ref: '#/texts/12' });
    const r = doclingToSegmentation(d);
    const tail = r.blocks.slice(-2);
    expect(tail.map(b => [b.page, b.hint, b.text, b.signals.headingDepth])).toEqual([
      [7, 'heading', 'TREES', 1],
      [7, 'subheading', '3.1 Rooted trees', 2],
    ]);
    expect(r.blocks.some(b => /CHAPTER 2/.test(b.text) || b.text === 'Chapter 3')).toBe(false);
    expect(r.blocks.map(b => b.readingOrder)).toEqual(r.blocks.map((_, i) => i));
    expect(r.diagnostics).toMatchObject({ merged_broken_headings: 1, repeating_header_stripped: 4 });
  });

  it('rejects documents it does not understand', () => {
    expect(() => assertSupportedDoclingDocument({ schema_name: 'DoclingDocument', version: '2.0.0', body: {} })).toThrow(/Unsupported/);
    expect(() => assertSupportedDoclingDocument({ md_content: '# x' })).toThrow(/Unsupported/);
    expect(() => assertSupportedDoclingDocument(fixture())).not.toThrow();
  });
});

describe('convertPdfWithDocling', () => {
  const pdf = path.join(os.tmpdir(), `docling-test-${process.pid}.pdf`);
  fs.writeFileSync(pdf, '%PDF-1.4 test');
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  it('submits async, polls until success, and returns the DoclingDocument', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/v1/convert/file/async')) {
        const form = init!.body as FormData;
        expect(form.getAll('to_formats')).toEqual(['json']);
        expect(form.get('do_ocr')).toBe('false');
        return json({ task_id: 'abc', task_status: 'pending' });
      }
      if (url.includes('/v1/status/poll/abc')) return json({ task_status: ++polls < 2 ? 'started' : 'success' });
      if (url.endsWith('/v1/result/abc')) return json({ status: 'success', document: { json_content: fixture() } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const doc = await convertPdfWithDocling(pdf, { baseUrl: 'http://127.0.0.1:5001/', pollMs: 1, fetchImpl });
    expect(doc.schema_name).toBe('DoclingDocument');
    expect(calls).toEqual(['POST /v1/convert/file/async', 'GET /v1/status/poll/abc', 'GET /v1/status/poll/abc', 'GET /v1/result/abc']);
  });

  it('surfaces task failure and unreachable servers as errors', async () => {
    const failing = (async (url: string) => (url.endsWith('/async') ? json({ task_id: 't' }) : json({ task_status: 'failure', error_message: 'bad pdf' }))) as unknown as typeof fetch;
    await expect(convertPdfWithDocling(pdf, { baseUrl: 'http://x', pollMs: 1, fetchImpl: failing })).rejects.toThrow(/bad pdf/);
    const down = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
    await expect(convertPdfWithDocling(pdf, { baseUrl: 'http://x', pollMs: 1, fetchImpl: down })).rejects.toThrow(/could not be reached/);
  });
});
