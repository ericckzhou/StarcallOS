// Pure page-anchoring math for the continuous-scroll PdfViewer. The viewer
// reads DOM geometry and hands it here, so the rules that keep the header's
// logical page and the visible PDF page from drifting apart are unit-tested.

export interface PageGeometry {
  page: number;
  // Page top relative to the scroll container's top, in px (0 = aligned).
  top: number;
  height: number;
}

export interface PageAnchor {
  page: number;
  // How far the anchor page is scrolled past the container top (px, ≥ 0).
  offset: number;
  // offset / page height, clamped to [0, 1] — survives zoom/resize.
  ratio: number;
}

export interface SavedPdfViewState {
  page: number;
  scrollTop: number;
}

// Slack for sub-pixel layout: a page whose top sits up to this far below the
// container top still counts as "started".
const STARTED_EPSILON_PX = 4;

// The current page is the lowest page whose top has reached the container top
// (the one being read). If no page has started — e.g. a gap above page 1 —
// fall back to the page whose top is closest to the container top.
export function pickAnchorPage(pages: Iterable<PageGeometry>): PageAnchor {
  let best: PageGeometry | null = null;
  let fallback: PageGeometry | null = null;
  for (const p of pages) {
    if (p.top <= STARTED_EPSILON_PX && (best === null || p.top >= best.top)) best = p;
    if (fallback === null || Math.abs(p.top) < Math.abs(fallback.top)) fallback = p;
  }
  const chosen = best ?? fallback;
  if (!chosen) return { page: 1, offset: 0, ratio: 0 };
  const offset = Math.max(0, -chosen.top);
  const height = Math.max(1, chosen.height);
  return { page: chosen.page, offset, ratio: Math.max(0, Math.min(1, offset / height)) };
}

// After a layout change (zoom, rail toggle, pane resize) the anchor page has a
// new height. Restore the same relative position inside it: the new in-page
// offset, and how much to add to scrollTop given the page's current rect delta
// from the container top. The offset never reaches past the page's last pixel.
export function reanchorScroll(ratio: number, pageHeight: number, rectDelta: number): { offset: number; scrollBy: number } {
  const offset = Math.min(Math.max(0, pageHeight - 1), ratio * Math.max(1, pageHeight));
  return { offset, scrollBy: rectDelta + offset };
}

export function clampPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(Math.floor(page), Math.max(1, totalPages)));
}

// Parse a persisted view state; anything malformed is null (start fresh).
export function parseSavedPdfViewState(raw: string | null): SavedPdfViewState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedPdfViewState> | null;
    if (!parsed || !Number.isFinite(parsed.page) || !Number.isFinite(parsed.scrollTop)) return null;
    return { page: Number(parsed.page), scrollTop: Math.max(0, Number(parsed.scrollTop)) };
  } catch {
    return null;
  }
}

export function serializePdfViewState(state: SavedPdfViewState): string {
  return JSON.stringify({
    page: Math.max(1, Math.floor(state.page)),
    scrollTop: Math.max(0, Math.floor(state.scrollTop)),
  });
}
