import { describe, expect, it } from 'vitest';
import { clampPage, pageCount, pageOffset, pageSliceBounds, pageWindow } from './pagination-window';

describe('pageCount', () => {
  it('splits a total into whole pages, rounding up', () => {
    expect(pageCount(50, 25)).toBe(2);
    expect(pageCount(51, 25)).toBe(3);
    expect(pageCount(1, 25)).toBe(1);
  });

  it('reports 0 pages for an empty list (so the control hides)', () => {
    expect(pageCount(0, 25)).toBe(0);
  });

  it('is defensive against bad input', () => {
    expect(pageCount(10, 0)).toBe(0);
    expect(pageCount(-5, 25)).toBe(0);
    expect(pageCount(Number.NaN, 25)).toBe(0);
    expect(pageCount(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('clampPage', () => {
  it('keeps a page within [1, pages]', () => {
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-2, 5)).toBe(1);
  });

  it('never drops below page 1, even for an empty list', () => {
    expect(clampPage(1, 0)).toBe(1);
    expect(clampPage(3, 0)).toBe(1);
  });

  it('falls back to page 1 for non-finite input', () => {
    expect(clampPage(Number.NaN, 5)).toBe(1);
  });
});

describe('pageSliceBounds', () => {
  it('returns [start, end) for a client-side slice', () => {
    expect(pageSliceBounds(1, 25, 60)).toEqual({ start: 0, end: 25 });
    expect(pageSliceBounds(2, 25, 60)).toEqual({ start: 25, end: 50 });
    expect(pageSliceBounds(3, 25, 60)).toEqual({ start: 50, end: 60 });
  });

  it('clamps an out-of-range page to the last page rather than overrunning', () => {
    expect(pageSliceBounds(9, 25, 60)).toEqual({ start: 50, end: 60 });
  });

  it('is safe for an empty list', () => {
    expect(pageSliceBounds(1, 25, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('pageOffset', () => {
  it('is the zero-based offset of a page for a LIMIT/OFFSET read', () => {
    expect(pageOffset(1, 25)).toBe(0);
    expect(pageOffset(3, 25)).toBe(50);
  });
});

describe('pageWindow', () => {
  it('lists every page with no gaps when they all fit', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('collapses runs to a single ellipsis around the middle', () => {
    expect(pageWindow(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
  });

  it('keeps the last page pinned when near the start', () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
  });

  it('keeps the first page pinned when near the end', () => {
    expect(pageWindow(10, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
  });

  it('always includes the first, last and current pages', () => {
    for (let current = 1; current <= 20; current += 1) {
      const window = pageWindow(current, 20);
      expect(window).toContain(1);
      expect(window).toContain(20);
      expect(window).toContain(current);
    }
  });

  it('never renders a lone hidden page as an ellipsis (shows the page instead)', () => {
    // A gap of exactly one page is filled by that page, not a "…" that hides a single number.
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('clamps an out-of-range current page before building the strip', () => {
    expect(pageWindow(99, 5)).toEqual(pageWindow(5, 5));
  });

  it('returns an empty strip when there are no pages', () => {
    expect(pageWindow(1, 0)).toEqual([]);
  });
});
