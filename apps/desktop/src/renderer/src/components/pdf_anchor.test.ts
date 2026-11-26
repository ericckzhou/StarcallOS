import { describe, expect, it } from 'vitest';
import { clampPage, parseSavedPdfViewState, pickAnchorPage, reanchorScroll, serializePdfViewState, type PageGeometry } from './pdf_anchor';

// Three 1000px pages stacked with 10px gaps, scrolled so the container top
// sits `scroll` px into the stack.
function stack(scroll: number, height = 1000, gap = 10): PageGeometry[] {
  return [1, 2, 3].map((page, i) => ({ page, top: i * (height + gap) - scroll, height }));
}

describe('pickAnchorPage', () => {
  it('picks the page the container top is inside, with offset and ratio', () => {
    expect(pickAnchorPage(stack(0))).toEqual({ page: 1, offset: 0, ratio: 0 });
    expect(pickAnchorPage(stack(250))).toEqual({ page: 1, offset: 250, ratio: 0.25 });
    // 1010 = page 2 top exactly at the container top.
    expect(pickAnchorPage(stack(1010))).toEqual({ page: 2, offset: 0, ratio: 0 });
    expect(pickAnchorPage(stack(1510))).toEqual({ page: 2, offset: 500, ratio: 0.5 });
  });

  it('counts a page starting within 4px below the top as current (sub-pixel slack)', () => {
    expect(pickAnchorPage(stack(1007)).page).toBe(2); // page 2 top at +3px
    expect(pickAnchorPage(stack(1005)).page).toBe(1); // +5px: still on page 1
  });

  it('is independent of page iteration order', () => {
    const pages = stack(1510);
    expect(pickAnchorPage([...pages].reverse())).toEqual(pickAnchorPage(pages));
  });

  it('falls back to the page closest to the top when none has started', () => {
    // Container top sits 30px above page 1 (top padding).
    const a = pickAnchorPage(stack(-30));
    expect(a).toEqual({ page: 1, offset: 0, ratio: 0 });
  });

  it('clamps the ratio and tolerates zero-height and empty input', () => {
    expect(pickAnchorPage([{ page: 4, top: -50, height: 0 }])).toEqual({ page: 4, offset: 50, ratio: 1 });
    expect(pickAnchorPage([])).toEqual({ page: 1, offset: 0, ratio: 0 });
  });
});

describe('reanchorScroll', () => {
  it('keeps the same relative position after a zoom changes page height', () => {
    // Was 25% into a 1000px page; after zoom the page is 1600px and sits
    // 300px below the container top.
    expect(reanchorScroll(0.25, 1600, 300)).toEqual({ offset: 400, scrollBy: 700 });
  });

  it('never scrolls past the last pixel of the page', () => {
    expect(reanchorScroll(1, 800, 0)).toEqual({ offset: 799, scrollBy: 799 });
    expect(reanchorScroll(0.5, 0, -20)).toEqual({ offset: 0, scrollBy: -20 });
  });

  it('round-trips with pickAnchorPage across a height change', () => {
    const before = pickAnchorPage(stack(2020 + 300)); // 30% into page 3
    const after = stack(0, 1500, 10); // zoomed in, scrolled to top
    const page3 = after.find(p => p.page === before.page)!;
    const { scrollBy } = reanchorScroll(before.ratio, page3.height, page3.top);
    expect(pickAnchorPage(stack(scrollBy, 1500, 10))).toEqual({ page: 3, offset: 450, ratio: 0.3 });
  });
});

describe('clampPage', () => {
  it('floors and clamps into [1, total]', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(4.9, 10)).toBe(4);
    expect(clampPage(99, 10)).toBe(10);
    expect(clampPage(3, 0)).toBe(1);
  });
});

describe('saved view state', () => {
  it('round-trips, flooring and clamping on write', () => {
    const raw = serializePdfViewState({ page: 3.7, scrollTop: -12.5 });
    expect(parseSavedPdfViewState(raw)).toEqual({ page: 3, scrollTop: 0 });
  });

  it('rejects missing, malformed, or non-numeric state', () => {
    expect(parseSavedPdfViewState(null)).toBeNull();
    expect(parseSavedPdfViewState('{oops')).toBeNull();
    expect(parseSavedPdfViewState('null')).toBeNull();
    expect(parseSavedPdfViewState('{"page":"2","scrollTop":10}')).toBeNull();
    expect(parseSavedPdfViewState('{"page":2}')).toBeNull();
  });
});
