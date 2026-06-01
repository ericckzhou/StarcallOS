import { describe, it, expect } from 'vitest';
import { pageTextFromItems, pagesFromFormFeeds } from './pdf';

// ─── pageTextFromItems ────────────────────────────────────────────────────────

describe('pageTextFromItems', () => {
  it('joins items with a space when hasEOL is false', () => {
    const result = pageTextFromItems(
      [{ str: 'Hello', hasEOL: false }, { str: 'world', hasEOL: false }],
      0,
    );
    expect(result.text).toBe('Hello world');
  });

  it('joins items with a newline when hasEOL is true', () => {
    const result = pageTextFromItems(
      [{ str: 'Line one', hasEOL: true }, { str: 'Line two', hasEOL: false }],
      0,
    );
    expect(result.text).toBe('Line one\nLine two');
  });

  it('trims leading and trailing whitespace', () => {
    const result = pageTextFromItems([{ str: '  padded  ', hasEOL: false }], 0);
    expect(result.text).toBe('padded');
  });

  it('converts pageIndex to 1-based page number', () => {
    expect(pageTextFromItems([{ str: 'A' }], 0).page).toBe(1);
    expect(pageTextFromItems([{ str: 'A' }], 4).page).toBe(5);
  });

  it('returns empty string for a page with no items', () => {
    expect(pageTextFromItems([], 0).text).toBe('');
  });

  it('treats missing hasEOL as false (space separator)', () => {
    const result = pageTextFromItems(
      [{ str: 'A' }, { str: 'B' }],
      0,
    );
    expect(result.text).toBe('A B');
  });
});

// ─── pagesFromFormFeeds ───────────────────────────────────────────────────────

describe('pagesFromFormFeeds', () => {
  it('splits on form-feed and assigns 1-based page numbers', () => {
    const pages = pagesFromFormFeeds('Page one\fPage two\fPage three');
    expect(pages).toHaveLength(3);
    expect(pages[0]).toEqual({ page: 1, text: 'Page one' });
    expect(pages[1]).toEqual({ page: 2, text: 'Page two' });
    expect(pages[2]).toEqual({ page: 3, text: 'Page three' });
  });

  it('trims whitespace from each page', () => {
    const pages = pagesFromFormFeeds('  padded  \f  also padded  ');
    expect(pages[0].text).toBe('padded');
    expect(pages[1].text).toBe('also padded');
  });

  it('filters out empty segments from consecutive form-feeds', () => {
    const pages = pagesFromFormFeeds('A\f\fB');
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toBe('A');
    expect(pages[1].text).toBe('B');
  });

  it('returns [] for text with no form-feeds and no content', () => {
    expect(pagesFromFormFeeds('')).toEqual([]);
  });

  it('returns a single page when there are no form-feeds', () => {
    const pages = pagesFromFormFeeds('No page breaks here.');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ page: 1, text: 'No page breaks here.' });
  });

  it('ignores leading and trailing form-feeds', () => {
    const pages = pagesFromFormFeeds('\fFirst\fSecond\f');
    expect(pages.map(p => p.text)).toEqual(['First', 'Second']);
  });
});
