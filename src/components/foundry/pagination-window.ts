/**
 * Pure pagination maths (issue #20) — the page-window arithmetic behind the Foundry
 * {@link Pagination} control. No React, no DOM, no store: every rule a paginator has to get
 * right — how many pages a total splits into, clamping a page into range, the slice bounds
 * for a client-side page, and *which* page buttons to draw (with gaps) — lives here so it is
 * exhaustively unit-testable in isolation. The same "logic out of glue" seam as the
 * virtualised `list-window.ts` and the i18n `i18n.ts`.
 */

/** A rendered page-strip cell: a concrete page number, or a collapsed run shown as an ellipsis. */
export type PageWindowItem = number | 'ellipsis';

/**
 * How many pages `totalItems` splits into at `pageSize`. Zero items (or a non-positive page
 * size) is **0 pages** — the caller treats "> 1" as "worth paginating", so an empty or
 * single-page list reports 0/1 and the control hides. Never negative.
 */
export function pageCount(totalItems: number, pageSize: number): number {
  if (!Number.isFinite(totalItems) || !Number.isFinite(pageSize) || pageSize <= 0 || totalItems <= 0) {
    return 0;
  }
  return Math.ceil(totalItems / pageSize);
}

/**
 * Clamp a (1-based) page into the valid range `[1, max(1, pages)]`, so a stale page number —
 * e.g. after the list shrinks under a filter — snaps back into range rather than showing an
 * empty page. Always ≥ 1 (page 1 is valid even for an empty list). Non-finite input → 1.
 */
export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 1;
  const last = Math.max(1, Math.floor(pages));
  return Math.min(Math.max(1, Math.floor(page)), last);
}

/**
 * The zero-based `[start, end)` slice bounds for `page` (1-based) over `totalItems` — for
 * client-side pagination that slices already-loaded rows. `end` never exceeds `totalItems`,
 * and `start` never exceeds `end`, so `rows.slice(start, end)` is always safe.
 */
export function pageSliceBounds(
  page: number,
  pageSize: number,
  totalItems: number,
): { start: number; end: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const total = Math.max(0, Math.floor(totalItems));
  const clamped = clampPage(page, pageCount(total, size));
  const start = Math.min((clamped - 1) * size, total);
  const end = Math.min(start + size, total);
  return { start, end };
}

/** The zero-based row offset for `page` (1-based) at `pageSize` — for a server `LIMIT/OFFSET` read. */
export function pageOffset(page: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize));
  return Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size);
}

/** Inclusive integer range `[start, end]`; empty when `start > end`. */
function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}

export interface PageWindowOptions {
  /** Pages either side of the current page always shown (default 1). */
  readonly siblingCount?: number;
  /** Pages pinned at each end (first/last) always shown (default 1). */
  readonly boundaryCount?: number;
}

/**
 * The sequence of page cells to render for `currentPage` of `totalPages` — the pinned
 * boundary pages, a sliding window of siblings around the current page, and `'ellipsis'`
 * markers where a run is collapsed. Adapted from the well-worn MUI `usePagination`
 * algorithm. A single ellipsis is only inserted where it actually saves space: a gap of
 * exactly one page renders that page instead (never an ellipsis hiding a lone page).
 *
 * `currentPage` is clamped into range first, so an out-of-range input can't produce a
 * malformed strip. Returns `[]` when there are no pages.
 */
export function pageWindow(
  currentPage: number,
  totalPages: number,
  { siblingCount = 1, boundaryCount = 1 }: PageWindowOptions = {},
): PageWindowItem[] {
  const pages = Math.max(0, Math.floor(totalPages));
  if (pages <= 0) return [];
  const current = clampPage(currentPage, pages);

  const startPages = range(1, Math.min(boundaryCount, pages));
  const endPages = range(Math.max(pages - boundaryCount + 1, boundaryCount + 1), pages);

  const siblingsStart = Math.max(
    Math.min(current - siblingCount, pages - boundaryCount - siblingCount * 2 - 1),
    boundaryCount + 2,
  );
  const siblingsEnd = Math.min(
    Math.max(current + siblingCount, boundaryCount + siblingCount * 2 + 2),
    endPages.length > 0 ? endPages[0]! - 2 : pages - 1,
  );

  const items: PageWindowItem[] = [
    ...startPages,
    // Left gap: an ellipsis when >1 page is hidden, the single hidden page itself when exactly one.
    ...(siblingsStart > boundaryCount + 2
      ? (['ellipsis'] as PageWindowItem[])
      : boundaryCount + 1 < pages - boundaryCount
        ? [boundaryCount + 1]
        : []),
    ...range(siblingsStart, siblingsEnd),
    // Right gap: mirror of the left.
    ...(siblingsEnd < pages - boundaryCount - 1
      ? (['ellipsis'] as PageWindowItem[])
      : pages - boundaryCount > boundaryCount
        ? [pages - boundaryCount]
        : []),
    ...endPages,
  ];
  return items;
}
