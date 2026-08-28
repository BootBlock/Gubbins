/**
 * Pure dashboard widget-grid layout maths (spec §3 "Customisable Dashboard", §2.1
 * `useLayoutStore` "dashboard widget layout coordinates").
 *
 * The customisable dashboard places widgets at explicit `(x, y)` grid coordinates and
 * gives each one a `w × h` span in whole cells, so a user can drag a tile to any cell,
 * reorder, resize and show/hide. All the coordinate arithmetic — placement, span
 * clamping, swap-on-collision, keyboard nudge, registry reconcile and visibility —
 * lives here as deterministic, side-effect-free functions, mirroring the
 * `tree-keyboard.ts` / `list-window.ts` / `focus-trap.ts` "extract the logic out of
 * the DOM glue" seam. The React grid (drag-and-drop + roving focus) is a thin shell
 * over these; `useLayoutStore` persists the result to localStorage (device-local, no
 * schema migration).
 */

/** Fixed column count of the dashboard grid; rows grow unbounded downward. */
export const DASHBOARD_COLUMNS = 3;

/**
 * Largest span a widget may take, in cells (issue #441). Capped below the column count
 * on purpose: a 2-wide card still leaves a column for a neighbour, so no single card can
 * own a whole row, and the option set stays small enough to offer as four explicit sizes.
 */
export const MAX_WIDGET_WIDTH = 2;
export const MAX_WIDGET_HEIGHT = 2;

/**
 * Every span a widget may be resized to, in the order the size picker offers them (widest
 * varying first, so the four read as two rows of two). Derived from the caps above rather
 * than listed, so raising a cap offers the new sizes everywhere at once.
 */
export const WIDGET_SIZE_OPTIONS: readonly { readonly w: number; readonly h: number }[] = Array.from(
  { length: MAX_WIDGET_HEIGHT },
  (_, hi) => Array.from({ length: MAX_WIDGET_WIDTH }, (_, wi) => ({ w: wi + 1, h: hi + 1 })),
).flat();

/** One widget's placement on the grid. A hidden placement keeps its last coords. */
export interface WidgetPlacement {
  readonly id: string;
  /** Column of the left edge, `0 .. DASHBOARD_COLUMNS - w`. */
  readonly x: number;
  /** Row of the top edge, `0 ..` (unbounded). */
  readonly y: number;
  /** Width in cells, `1 .. MAX_WIDGET_WIDTH`. */
  readonly w: number;
  /** Height in cells, `1 .. MAX_WIDGET_HEIGHT`. */
  readonly h: number;
  /** Whether the widget is pinned to the board; hidden widgets don't occupy a cell. */
  readonly visible: boolean;
}

export type DashboardLayout = readonly WidgetPlacement[];

export type NudgeDirection = 'up' | 'down' | 'left' | 'right';

/** A rectangle of cells, used for the overlap tests below. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Coerce a persisted span into range. A layout written by a build that predates resizing
 * carries no `w`/`h` at all, and the store's rehydration path hands us whatever `JSON.parse`
 * returned, so this is the one place a span is trusted (see the memory note
 * `persisted-state-reconcile-on-read`). Anything that is not a finite number resolves to 1.
 */
function normaliseSpan(value: unknown, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  if (n < 1) return 1;
  return n > max ? max : n;
}

/** The placement's span, defaulted and clamped — never trust a stored `w`/`h` directly. */
function spanOf(p: WidgetPlacement): { w: number; h: number } {
  return { w: normaliseSpan(p.w, MAX_WIDGET_WIDTH), h: normaliseSpan(p.h, MAX_WIDGET_HEIGHT) };
}

/** The cells a placement occupies, as a rectangle. */
function rectOf(p: WidgetPlacement): Rect {
  const { w, h } = spanOf(p);
  return { x: p.x, y: p.y, w, h };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function rectCoversCell(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Every visible widget whose cells overlap `rect`, excluding `ignoreId`. */
function widgetsOverlapping(layout: DashboardLayout, rect: Rect, ignoreId: string): WidgetPlacement[] {
  return layout.filter((p) => p.visible && p.id !== ignoreId && rectsOverlap(rectOf(p), rect));
}

/** Flow `ids` row-major into the fixed-column grid, every widget visible at 1×1. */
export function defaultLayout(ids: readonly string[]): DashboardLayout {
  return ids.map((id, i) => ({
    id,
    x: i % DASHBOARD_COLUMNS,
    y: Math.floor(i / DASHBOARD_COLUMNS),
    w: 1,
    h: 1,
    visible: true,
  }));
}

/** Visible placements only, sorted row-major (then by id) for stable render order. */
export function placedWidgets(layout: DashboardLayout): DashboardLayout {
  return layout
    .filter((p) => p.visible)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

/**
 * Repack `placements` gaplessly row-major, each keeping its own span and their existing
 * relative order. Used by the hide-healthy render transform below; a widget lands in the
 * first cell where its whole rectangle fits, so a wide card skips a one-cell hole rather
 * than hanging over the board's right edge.
 */
function repack(placements: DashboardLayout): DashboardLayout {
  let result: DashboardLayout = [];
  for (const p of placements) {
    const { w, h } = spanOf(p);
    const cell = firstFreeCell(result, w, h);
    result = [...result, { id: p.id, x: cell.x, y: cell.y, w, h, visible: true }];
  }
  return result;
}

/**
 * View-mode "hide healthy cards" transform (issue #111): drop the widgets whose id is in
 * `hideIds` and re-flow the survivors gaplessly row-major, so hiding an all-clear alert card
 * closes the hole it would otherwise strand mid-grid. This is purely a *render* transform —
 * the persisted layout (and every edit) still operates on the full set, so the hidden cards'
 * real coordinates are never rewritten. Returns the same reference when `hideIds` is empty
 * (the common no-op fast path, e.g. the option is off or the board is being customised).
 */
export function hideHealthyCards(layout: DashboardLayout, hideIds: ReadonlySet<string>): DashboardLayout {
  if (hideIds.size === 0) return layout;
  return repack(placedWidgets(layout).filter((p) => !hideIds.has(p.id)));
}

/** The visible widget covering cell `(x, y)`, if any — a multi-cell widget covers all of its. */
export function occupantAt(layout: DashboardLayout, x: number, y: number): WidgetPlacement | undefined {
  return layout.find((p) => p.visible && rectCoversCell(rectOf(p), x, y));
}

/**
 * The first row-major cell where a `w × h` rectangle fits with no visible widget under any
 * of its cells (a hidden widget's cells are free). The rectangle is kept inside the board's
 * columns, so a 2-wide widget never starts in the last column.
 *
 * @internal Exported for unit tests only.
 */
export function firstFreeCell(layout: DashboardLayout, w = 1, h = 1): { x: number; y: number } {
  const width = normaliseSpan(w, MAX_WIDGET_WIDTH);
  const height = normaliseSpan(h, MAX_WIDGET_HEIGHT);
  for (let y = 0; ; y++) {
    for (let x = 0; x <= DASHBOARD_COLUMNS - width; x++) {
      if (widgetsOverlapping(layout, { x, y, w: width, h: height }, '').length === 0) return { x, y };
    }
  }
}

/** Clamp a left edge so a `w`-wide widget stays inside the board. */
function clampColumn(x: number, w: number): number {
  const max = DASHBOARD_COLUMNS - w;
  if (x < 0) return 0;
  return x > max ? max : x;
}

/**
 * Move the visible widget `id` so its top-left corner sits at `(x, y)`.
 *
 * Collision rule (issue #441): a target region held by exactly one widget **of the same
 * size** swaps with the subject, which is the 1×1 behaviour the board has always had. Any
 * other clash — a differently-sized neighbour, two widgets partly under the target, or a swap
 * the subject would land back on top of — is refused rather than guessed at, so moving one card
 * never rearranges cards the user did not touch. The column is clamped so the widget stays on
 * the board and the row floored at 0; an unknown/hidden id, a refused move, or a move onto its
 * own cell is a no-op (returns the same array reference).
 */
export function moveWidget(layout: DashboardLayout, id: string, x: number, y: number): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || !subject.visible) return layout;

  const { w, h } = spanOf(subject);
  const tx = clampColumn(x, w);
  const ty = Math.max(0, Math.floor(y));
  if (subject.x === tx && subject.y === ty) return layout;

  const blocking = widgetsOverlapping(layout, { x: tx, y: ty, w, h }, id);
  if (blocking.length > 1) return layout;

  const occupant = blocking[0];
  if (occupant) {
    const theirs = spanOf(occupant);
    // Only an equal-sized neighbour can swap: any other pairing would leave one of the two
    // hanging over a cell the move never checked.
    if (theirs.w !== w || theirs.h !== h) return layout;
    // A swap hands the occupant the subject's *old* rectangle, which is only free if the
    // subject has genuinely left it. A multi-cell card moved by less than its own span still
    // covers part of where it was, so the two would land on top of each other — refuse, the
    // same as any other clash. (For 1×1 cards the two rectangles are always disjoint, so this
    // never changes the behaviour the board has always had.)
    if (rectsOverlap({ x: subject.x, y: subject.y, w, h }, { x: tx, y: ty, w, h })) return layout;
  }

  return layout.map((p) => {
    if (p.id === id) return { ...p, x: tx, y: ty, w, h };
    // Swap: the displaced occupant takes the subject's vacated cells.
    if (occupant && p.id === occupant.id) return { ...p, x: subject.x, y: subject.y };
    return p;
  });
}

/** Nudge a widget one cell in a direction (keyboard); a move past an edge is a no-op. */
export function nudgeWidget(layout: DashboardLayout, id: string, dir: NudgeDirection): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || !subject.visible) return layout;

  const { w } = spanOf(subject);
  let { x, y } = subject;
  if (dir === 'left') x -= 1;
  else if (dir === 'right') x += 1;
  else if (dir === 'up') y -= 1;
  else y += 1;

  // Reject only off-grid moves; an empty in-bounds cell is a legitimate target.
  if (x < 0 || x + w > DASHBOARD_COLUMNS || y < 0) return layout;
  return moveWidget(layout, id, x, y);
}

/**
 * Resize the visible widget `id` to a `w × h` span (issue #441).
 *
 * The span is clamped into `1 .. MAX_WIDGET_*`, and a widget growing wider than the room to
 * its right shifts left to stay on the board rather than being refused outright — the common
 * case of widening a card that sits in the last column. The resize is then refused (a no-op,
 * same array reference) if the new rectangle would overlap any other visible widget, which is
 * what lets the size buttons render disabled instead of shoving neighbours around.
 */
export function resizeWidget(layout: DashboardLayout, id: string, w: number, h: number): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || !subject.visible) return layout;

  const width = normaliseSpan(w, MAX_WIDGET_WIDTH);
  const height = normaliseSpan(h, MAX_WIDGET_HEIGHT);
  const current = spanOf(subject);
  const x = clampColumn(subject.x, width);
  if (current.w === width && current.h === height && subject.x === x) return layout;

  if (widgetsOverlapping(layout, { x, y: subject.y, w: width, h: height }, id).length > 0) return layout;
  return layout.map((p) => (p.id === id ? { ...p, x, w: width, h: height } : p));
}

/**
 * Pin or unpin a widget. Hiding flips the flag (the widget stops occupying its cells
 * but keeps its coords); re-showing reclaims the first free cell that fits its span, so
 * it never lands on top of another. A no-op when the state already matches or the id is
 * unknown.
 */
export function setWidgetVisible(layout: DashboardLayout, id: string, visible: boolean): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || subject.visible === visible) return layout;

  if (!visible) {
    return layout.map((p) => (p.id === id ? { ...p, visible: false } : p));
  }
  const { w, h } = spanOf(subject);
  const cell = firstFreeCell(layout, w, h);
  return layout.map((p) => (p.id === id ? { ...p, x: cell.x, y: cell.y, w, h, visible: true } : p));
}

/**
 * Repair a layout in which two visible widgets overlap, by re-homing every placement after
 * the first claimant of a cell into the first genuinely free rectangle (row-major). Returns
 * the same reference when nothing overlaps, which is the normal case — a well-formed layout
 * is never rewritten.
 *
 * This is the read-side belt and braces for issue #627: the edit ops keep a collision
 * from being *made*, but a board arranged by an older build (or synced in from another
 * device) can already carry one, and two tiles stacked in one cell leave the underneath
 * one unreadable and unclickable.
 */
function dedupeCells(layout: DashboardLayout): DashboardLayout {
  const settled: WidgetPlacement[] = [];
  const clashes: number[] = [];
  layout.forEach((p, i) => {
    if (!p.visible) return;
    const rect = rectOf(p);
    if (settled.some((q) => rectsOverlap(rectOf(q), rect))) clashes.push(i);
    else settled.push(p);
  });
  if (clashes.length === 0) return layout;

  // Re-home one at a time through the same `firstFreeCell` the rest of this module uses, so
  // each move sees the previous one's landing cell as taken. A placement still awaiting a home
  // holds its overlapping cells meanwhile, which are cells an earlier claimant already holds —
  // so it narrows nothing that wasn't already occupied.
  let result = layout;
  for (const i of clashes) {
    const { w, h } = spanOf(result[i]!);
    const cell = firstFreeCell(result, w, h);
    result = result.map((p, j) => (j === i ? { ...p, x: cell.x, y: cell.y } : p));
  }
  return result;
}

/**
 * Coerce one stored placement into a well-formed one: spans clamped into range (a layout
 * written before resizing shipped has none at all), the left edge kept on the board for that
 * span, and the row floored at 0.
 */
function normalisePlacement(p: WidgetPlacement): WidgetPlacement {
  const { w, h } = spanOf(p);
  const x = clampColumn(Math.floor(p.x) || 0, w);
  const y = Math.max(0, Math.floor(p.y) || 0);
  if (p.w === w && p.h === h && p.x === x && p.y === y) return p;
  return { ...p, x, y, w, h };
}

/**
 * Reconcile a stored layout against the live widget registry so the board survives the
 * registry changing across releases (a forward/backward-compatibility seam, mirroring
 * the Phase-39 "freshly-created locations" default and the §7.3 schema dictionary):
 * placements for unknown widgets are dropped, known placements keep their coords, span
 * and visibility, and newly-registered widgets are appended into the first free cell,
 * visible at 1×1. An empty stored layout yields the row-major default. Every placement is
 * normalised on read (a missing or out-of-range span, an off-board coordinate), and a stored
 * layout that already overlaps two widgets is repaired (see {@link dedupeCells}).
 */
export function reconcileLayout(stored: DashboardLayout, registryIds: readonly string[]): DashboardLayout {
  if (stored.length === 0) return defaultLayout(registryIds);

  const known = new Set(registryIds);
  let result: DashboardLayout = dedupeCells(stored.filter((p) => known.has(p.id)).map(normalisePlacement));

  for (const id of registryIds) {
    if (result.some((p) => p.id === id)) continue;
    const cell = firstFreeCell(result);
    result = [...result, { id, x: cell.x, y: cell.y, w: 1, h: 1, visible: true }];
  }
  return result;
}
