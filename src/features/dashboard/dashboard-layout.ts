/**
 * Pure dashboard widget-grid layout maths (spec §3 "Customisable Dashboard", §2.1
 * `useLayoutStore` "dashboard widget layout coordinates").
 *
 * The customisable dashboard places widgets at explicit `(x, y)` grid coordinates so
 * a user can drag a tile to any cell, reorder, and show/hide. All the coordinate
 * arithmetic — placement, swap-on-collision, keyboard nudge, registry reconcile and
 * visibility — lives here as deterministic, side-effect-free functions, mirroring the
 * `tree-keyboard.ts` / `list-window.ts` / `focus-trap.ts` "extract the logic out of
 * the DOM glue" seam. The React grid (drag-and-drop + roving focus) is a thin shell
 * over these; `useLayoutStore` persists the result to localStorage (device-local, no
 * schema migration).
 */

/** Fixed column count of the dashboard grid; rows grow unbounded downward. */
export const DASHBOARD_COLUMNS = 3;

/** One widget's placement on the grid. A hidden placement keeps its last coords. */
export interface WidgetPlacement {
  readonly id: string;
  /** Column, `0 .. DASHBOARD_COLUMNS - 1`. */
  readonly x: number;
  /** Row, `0 ..` (unbounded). */
  readonly y: number;
  /** Whether the widget is pinned to the board; hidden widgets don't occupy a cell. */
  readonly visible: boolean;
}

export type DashboardLayout = readonly WidgetPlacement[];

export type NudgeDirection = 'up' | 'down' | 'left' | 'right';

/** Flow `ids` row-major into the fixed-column grid, every widget visible. */
export function defaultLayout(ids: readonly string[]): DashboardLayout {
  return ids.map((id, i) => ({
    id,
    x: i % DASHBOARD_COLUMNS,
    y: Math.floor(i / DASHBOARD_COLUMNS),
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

/** The visible widget occupying cell `(x, y)`, if any. */
export function occupantAt(layout: DashboardLayout, x: number, y: number): WidgetPlacement | undefined {
  return layout.find((p) => p.visible && p.x === x && p.y === y);
}

/** The first row-major cell not occupied by a visible widget (a hidden cell is free). */
export function firstFreeCell(layout: DashboardLayout): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x < DASHBOARD_COLUMNS; x++) {
      if (!occupantAt(layout, x, y)) return { x, y };
    }
  }
}

function clampColumn(x: number): number {
  if (x < 0) return 0;
  if (x > DASHBOARD_COLUMNS - 1) return DASHBOARD_COLUMNS - 1;
  return x;
}

/**
 * Move the visible widget `id` to cell `(x, y)`. If another visible widget already
 * occupies the target, the two swap cells (deterministic, no holes-of-doom packing).
 * The column is clamped into range and the row floored at 0; an unknown/hidden id or a
 * move onto its own cell is a no-op (returns the same array reference).
 */
export function moveWidget(layout: DashboardLayout, id: string, x: number, y: number): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || !subject.visible) return layout;

  const tx = clampColumn(x);
  const ty = Math.max(0, Math.floor(y));
  if (subject.x === tx && subject.y === ty) return layout;

  const occupant = occupantAt(layout, tx, ty);
  return layout.map((p) => {
    if (p.id === id) return { ...p, x: tx, y: ty };
    // Swap: the displaced occupant takes the subject's vacated cell.
    if (occupant && p.id === occupant.id) return { ...p, x: subject.x, y: subject.y };
    return p;
  });
}

/** Nudge a widget one cell in a direction (keyboard); a move past an edge is a no-op. */
export function nudgeWidget(layout: DashboardLayout, id: string, dir: NudgeDirection): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || !subject.visible) return layout;

  let { x, y } = subject;
  if (dir === 'left') x -= 1;
  else if (dir === 'right') x += 1;
  else if (dir === 'up') y -= 1;
  else y += 1;

  // Reject only off-grid moves; an empty in-bounds cell is a legitimate target.
  if (x < 0 || x > DASHBOARD_COLUMNS - 1 || y < 0) return layout;
  return moveWidget(layout, id, x, y);
}

/**
 * Pin or unpin a widget. Hiding flips the flag (the widget stops occupying its cell
 * but keeps its coords); re-showing reclaims the first free cell so it never lands on
 * top of another. A no-op when the state already matches or the id is unknown.
 */
export function setWidgetVisible(layout: DashboardLayout, id: string, visible: boolean): DashboardLayout {
  const subject = layout.find((p) => p.id === id);
  if (!subject || subject.visible === visible) return layout;

  if (!visible) {
    return layout.map((p) => (p.id === id ? { ...p, visible: false } : p));
  }
  const cell = firstFreeCell(layout);
  return layout.map((p) => (p.id === id ? { ...p, x: cell.x, y: cell.y, visible: true } : p));
}

/**
 * Reconcile a stored layout against the live widget registry so the board survives the
 * registry changing across releases (a forward/backward-compatibility seam, mirroring
 * the Phase-39 "freshly-created locations" default and the §7.3 schema dictionary):
 * placements for unknown widgets are dropped, known placements keep their coords +
 * visibility, and newly-registered widgets are appended into the first free cell,
 * visible. An empty stored layout yields the row-major default.
 */
export function reconcileLayout(stored: DashboardLayout, registryIds: readonly string[]): DashboardLayout {
  if (stored.length === 0) return defaultLayout(registryIds);

  const known = new Set(registryIds);
  let result: DashboardLayout = stored.filter((p) => known.has(p.id));

  for (const id of registryIds) {
    if (result.some((p) => p.id === id)) continue;
    const cell = firstFreeCell(result);
    result = [...result, { id, x: cell.x, y: cell.y, visible: true }];
  }
  return result;
}
