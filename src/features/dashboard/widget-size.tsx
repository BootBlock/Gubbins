/**
 * Widget size seam (issue #441) — how much a resized dashboard card puts in the space it
 * has taken.
 *
 * A card resized to span more cells that simply stretched its three rows over twice the
 * height would be a worse card, not a bigger one, so the board hands each widget its own
 * span and the widget decides what to draw with it. `DashboardGrid` provides the size
 * around every tile body; a widget reads it with {@link useWidgetSize} and sizes its list
 * through the pure helpers here. Widgets with fixed content (the system-status trio) ignore
 * it and simply sit in a larger card.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMediaQuery, type MediaQueryProvider } from '@/components/foundry';

/** A widget's span on the board, in whole grid cells. */
export interface WidgetSize {
  readonly w: number;
  readonly h: number;
}

const DEFAULT_SIZE: WidgetSize = { w: 1, h: 1 };

/**
 * The viewport on which the board collapses to a single column — the complement of the `sm:`
 * breakpoint the grid placement is applied at, so a card either has a span or it does not;
 * there is no width at which the two disagree.
 *
 * The board's `PLACEMENT` and row-height classes are all `sm:`-prefixed, so below this width a
 * card occupies one full-width cell whatever span it was given. Its *content* has to make the
 * same call, or a card sized 2×2 on a tablet would draw twenty-two rows into a phone-width
 * card that is one row tall. `widget-size.test.ts` reads `--breakpoint-sm` out of
 * `src/styles/index.css` and asserts this query still matches it.
 */
export const BOARD_SINGLE_COLUMN_QUERY = '(width < 40rem)';

const WidgetSizeContext = createContext<WidgetSize>(DEFAULT_SIZE);

/**
 * The span of the tile this widget is drawn in. Defaults to 1×1 outside the board, so a
 * widget rendered on its own in a test (or anywhere else) behaves exactly as it always has.
 */
export function useWidgetSize(): WidgetSize {
  return useContext(WidgetSizeContext);
}

export function WidgetSizeProvider({
  w,
  h,
  mediaProvider,
  children,
}: {
  readonly w: number;
  readonly h: number;
  /** Test seam: `matchMedia` provider, mirroring the Foundry reveal/motion primitives. */
  readonly mediaProvider?: MediaQueryProvider;
  readonly children: ReactNode;
}) {
  // On a single-column board the span buys the card nothing, so it is reported as 1×1 and every
  // widget draws what it always drew. Where `matchMedia` is unavailable this reads `false` — the
  // span is honoured, and the `sm:`-prefixed CSS remains the authority on the layout either way.
  const singleColumn = useMediaQuery(BOARD_SINGLE_COLUMN_QUERY, mediaProvider);
  const value = useMemo(() => (singleColumn ? DEFAULT_SIZE : { w, h }), [singleColumn, w, h]);
  return <WidgetSizeContext.Provider value={value}>{children}</WidgetSizeContext.Provider>;
}

/**
 * How many rows of a list a card gains for each extra cell of height.
 *
 * A grid row is `--spacing-dashboard-row` tall plus the board's gap, and a widget row is a
 * line of `text-xs` plus its stack spacing, so eight is about what a card can show in the
 * height it gains without the row having to grow past its floor. It is a deliberate product
 * choice rather than a measurement — the grid row's minimum only ever expands to fit, so a
 * widget that draws a row or two more than this costs whitespace, never clipping.
 */
const EXTRA_LIST_ROWS_PER_CELL = 8;

/** How many columns a widget should lay its list out in at this size. */
export function listColumns(size: WidgetSize): number {
  return size.w >= 2 ? 2 : 1;
}

/**
 * How many list rows a widget should draw at this size, given the number it draws at 1×1.
 *
 * Height buys more rows per column, width buys a second column of them — so a 2×2 card of a
 * three-row list shows 22 rows, and a card left at 1×1 shows exactly the three it always did.
 */
export function listRowCount(size: WidgetSize, baseRows: number): number {
  const perColumn = baseRows + (size.h - 1) * EXTRA_LIST_ROWS_PER_CELL;
  return perColumn * listColumns(size);
}
