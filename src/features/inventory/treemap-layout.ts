/**
 * Pure squarified-treemap layout (Bruls, Huizing & van Wijk, 2000), kept DOM-, React- and
 * token-free so the geometry is unit-tested directly — the same "logic out of glue" seam as
 * `list-window.ts` / `location-tree.ts`. It turns a flat list of weighted data into rectangles
 * whose **area is proportional to weight**, packed to keep each tile as close to square as
 * possible (far more legible than a naive slice-and-dice strip).
 *
 * It powers both inventory visualisations: the value treemap (weight = stock value) and the
 * location map (weight = how much stock sits in each place). The caller supplies the pixel size
 * of the container (measured with a ResizeObserver) and positions each returned rect absolutely.
 */

/** The minimal shape the layout needs: a non-negative relative size. */
export interface TreemapDatum {
  /** Relative area weight. Non-finite or ≤ 0 weights are dropped (they have no area). */
  readonly weight: number;
}

/** One laid-out tile: the source datum plus its pixel rectangle within the container. */
export interface TreemapRect<T> {
  readonly datum: T;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A free (not-yet-filled) rectangle the algorithm lays rows into. */
interface Free {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell<T> {
  readonly datum: T;
  /** Area scaled to the container (`weight × containerArea / totalWeight`). */
  readonly area: number;
}

/**
 * The "worst" (largest) aspect ratio a row of `areas` would have if laid along a strip of the
 * given `side` length — the squarify quality metric. A lower value is squarer. An empty row is
 * `Infinity` so the first item is always accepted into a fresh row.
 */
function worstAspectRatio(areas: readonly number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  for (const a of areas) {
    if (a > max) max = a;
    if (a < min) min = a;
    sum += a;
  }
  if (sum <= 0 || min <= 0) return Number.POSITIVE_INFINITY;
  const sum2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
}

/**
 * Lay a finished row of cells into `free` along its shorter side, pushing the rects into `out`
 * and shrinking `free` to the remaining space. When the free rect is taller than wide the row is
 * a vertical strip on the left (items stacked top-to-bottom); otherwise a horizontal strip on top
 * (items left-to-right). Guards against a degenerate zero-area strip.
 */
function layoutRow<T>(row: readonly Cell<T>[], free: Free, out: TreemapRect<T>[]): void {
  const rowArea = row.reduce((s, c) => s + c.area, 0);
  if (rowArea <= 0) return;

  if (free.h <= free.w) {
    // Shorter side is the height → a vertical strip spanning the full height.
    const stripWidth = rowArea / free.h;
    let y = free.y;
    for (const cell of row) {
      const cellHeight = cell.area / stripWidth;
      out.push({ datum: cell.datum, x: free.x, y, width: stripWidth, height: cellHeight });
      y += cellHeight;
    }
    free.x += stripWidth;
    free.w -= stripWidth;
  } else {
    // Shorter side is the width → a horizontal strip spanning the full width.
    const stripHeight = rowArea / free.w;
    let x = free.x;
    for (const cell of row) {
      const cellWidth = cell.area / stripHeight;
      out.push({ datum: cell.datum, x, y: free.y, width: cellWidth, height: stripHeight });
      x += cellWidth;
    }
    free.y += stripHeight;
    free.h -= stripHeight;
  }
}

/**
 * Pack `data` into a `width × height` rectangle as a squarified treemap: each tile's area is
 * proportional to its weight, and the packing keeps tiles as square as possible.
 *
 * Zero/negative/non-finite weights are dropped (they have no area), so the returned tiles may be
 * fewer than the input. An empty input or a non-positive container yields no tiles. Tiles are
 * returned largest-first (the order they were placed); the caller keys them by their datum id.
 */
export function squarifyTreemap<T extends TreemapDatum>(
  data: readonly T[],
  width: number,
  height: number,
): TreemapRect<T>[] {
  const out: TreemapRect<T>[] = [];
  if (width <= 0 || height <= 0) return out;

  const positive = data.filter((d) => Number.isFinite(d.weight) && d.weight > 0);
  if (positive.length === 0) return out;

  const total = positive.reduce((s, d) => s + d.weight, 0);
  const scale = (width * height) / total;
  const cells: Cell<T>[] = positive
    .map((d) => ({ datum: d, area: d.weight * scale }))
    .sort((a, b) => b.area - a.area);

  const free: Free = { x: 0, y: 0, w: width, h: height };
  let row: Cell<T>[] = [];
  let index = 0;
  while (index < cells.length) {
    const side = Math.min(free.w, free.h);
    const candidate = cells[index]!;
    const currentWorst = worstAspectRatio(
      row.map((c) => c.area),
      side,
    );
    const nextWorst = worstAspectRatio(
      [...row, candidate].map((c) => c.area),
      side,
    );
    // Keep adding to the current row while it stays at least as square; otherwise flush it and
    // start a fresh row in the (now smaller) free rectangle.
    if (row.length === 0 || nextWorst <= currentWorst) {
      row.push(candidate);
      index += 1;
    } else {
      layoutRow(row, free, out);
      row = [];
    }
  }
  if (row.length > 0) layoutRow(row, free, out);

  return out;
}
