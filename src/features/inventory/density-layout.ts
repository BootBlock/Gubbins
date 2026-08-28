/**
 * How each per-item View mode lays its items out — the pure half of the render fork (issue #444).
 *
 * Three places draw the same four per-item modes: the flat virtualised list, the grouped view's
 * virtualised section body, and the grouped view's small plain-DOM section. Before Gallery and
 * Compact existed each of those carried an inline `density === 'data' ? … : …`, which was
 * survivable at two modes and would have been four near-identical two-way forks at four. So the
 * layout decision lives here once, as data, and the three call sites read it.
 *
 * `table` is present for exhaustiveness but never asks these questions: the Table view re-parents
 * its rows to a `role="table"` wrapper with its own `grid-template-columns`, so it takes neither a
 * column count nor a stacking class.
 */
import type { ItemDensity } from '@/state/stores/useLayoutStore';

/**
 * Minimum column width (px) for the modes drawn as a responsive multi-column grid, or `null` for
 * the one-item-per-line modes.
 *
 * Gallery packs tighter than Card because it carries less: a card has to fit a labelled field
 * list and an action footer on one line, a tile only a name and a caption. It is not made wider
 * still because the picture comes from `item_images.thumbnail_blob`, which is capped at 150px on
 * its long edge — past roughly this width the tile would be visibly upscaling a thumbnail rather
 * than showing a photograph.
 */
export const DENSITY_COLUMN_WIDTH = {
  visual: 280,
  gallery: 200,
  data: null,
  compact: null,
  table: null,
} as const satisfies Record<ItemDensity, number | null>;

/** The minimum column width for `density`, or `null` when it draws one item per line. */
export function densityColumnWidth(density: ItemDensity): number | null {
  return DENSITY_COLUMN_WIDTH[density];
}

/**
 * Whether `density` packs several items across a virtual row. Only these modes need a measured
 * column count (and the `useColumns` / `useSectionColumns` resize observers behind it).
 */
export function isMultiColumnDensity(density: ItemDensity): boolean {
  return densityColumnWidth(density) !== null;
}

/**
 * Classes for the wrapper holding **one virtual row's** items, inside the virtualised list. A
 * multi-column mode is a grid whose column count the caller supplies through
 * {@link densityGridStyle}; a single-column mode is a plain block whose only job is the gap to
 * the row beneath — the virtualiser positions the rows themselves.
 */
export function densityVirtualRowClass(density: ItemDensity): string {
  switch (density) {
    case 'visual':
      return 'grid gap-4 pb-4';
    case 'gallery':
      return 'grid gap-3 pb-3';
    case 'data':
      return 'pb-1.5';
    case 'compact':
      // Compact's whole point is fitting more names on screen, so the gap between lines is a
      // hairline rather than the row-sized gutter the Data view can afford.
      return 'pb-0.5';
    case 'table':
      return '';
  }
}

/**
 * Classes for the wrapper holding a **whole section's** items in the grouped view's small,
 * non-virtualised sections. Same modes, but the grid packs itself with `auto-fill` (see
 * {@link densitySectionGridStyle}) rather than taking a measured column count.
 */
export function densitySectionClass(density: ItemDensity): string {
  switch (density) {
    case 'visual':
      return 'grid gap-4';
    case 'gallery':
      return 'grid gap-3';
    case 'data':
      return 'flex flex-col gap-1.5';
    case 'compact':
      return 'flex flex-col gap-0.5';
    case 'table':
      return '';
  }
}

/** The virtual row's `grid-template-columns`, or `undefined` for a one-item-per-line mode. */
export function densityGridStyle(density: ItemDensity, columns: number): React.CSSProperties | undefined {
  if (!isMultiColumnDensity(density)) return undefined;
  return { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
}

/** A section's self-packing `grid-template-columns`, or `undefined` for a one-per-line mode. */
export function densitySectionGridStyle(density: ItemDensity): React.CSSProperties | undefined {
  const width = densityColumnWidth(density);
  if (width === null) return undefined;
  return { gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` };
}
