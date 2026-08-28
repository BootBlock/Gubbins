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

/** A widget's span on the board, in whole grid cells. */
export interface WidgetSize {
  readonly w: number;
  readonly h: number;
}

const DEFAULT_SIZE: WidgetSize = { w: 1, h: 1 };

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
  children,
}: {
  readonly w: number;
  readonly h: number;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ w, h }), [w, h]);
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
export const EXTRA_LIST_ROWS_PER_CELL = 8;

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
