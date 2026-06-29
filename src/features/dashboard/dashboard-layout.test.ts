import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_COLUMNS,
  defaultLayout,
  firstFreeCell,
  moveWidget,
  nudgeWidget,
  occupantAt,
  placedWidgets,
  reconcileLayout,
  setWidgetVisible,
  type DashboardLayout,
} from './dashboard-layout';

/** Compact helper: a visible placement at (x, y). */
function at(id: string, x: number, y: number, visible = true) {
  return { id, x, y, visible };
}

describe('defaultLayout', () => {
  it('flows ids row-major into the fixed column grid, all visible', () => {
    const layout = defaultLayout(['a', 'b', 'c', 'd']);
    expect(DASHBOARD_COLUMNS).toBe(3);
    expect(layout).toEqual([at('a', 0, 0), at('b', 1, 0), at('c', 2, 0), at('d', 0, 1)]);
  });

  it('returns an empty layout for no ids', () => {
    expect(defaultLayout([])).toEqual([]);
  });
});

describe('placedWidgets', () => {
  it('returns only visible placements, sorted by row then column', () => {
    const layout: DashboardLayout = [at('c', 2, 0), at('a', 0, 0), at('hidden', 1, 0, false), at('d', 0, 1)];
    expect(placedWidgets(layout).map((p) => p.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('occupantAt / firstFreeCell', () => {
  it('finds the visible occupant of a cell, ignoring hidden placements', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('ghost', 1, 0, false)];
    expect(occupantAt(layout, 0, 0)?.id).toBe('a');
    expect(occupantAt(layout, 1, 0)).toBeUndefined();
  });

  it('returns the first row-major free cell (a hidden cell counts as free)', () => {
    // (0,0) and (2,0) taken; (1,0) is only hidden → it is the first free cell.
    const layout: DashboardLayout = [at('a', 0, 0), at('c', 2, 0), at('ghost', 1, 0, false)];
    expect(firstFreeCell(layout)).toEqual({ x: 1, y: 0 });
  });

  it('spills onto the next row when the first row is full', () => {
    const layout = defaultLayout(['a', 'b', 'c']);
    expect(firstFreeCell(layout)).toEqual({ x: 0, y: 1 });
  });
});

describe('moveWidget', () => {
  it('moves a widget into an empty cell', () => {
    const layout = defaultLayout(['a', 'b', 'c']); // a@(0,0) b@(1,0) c@(2,0)
    const next = moveWidget(layout, 'a', 0, 1);
    expect(occupantAt(next, 0, 1)?.id).toBe('a');
    expect(occupantAt(next, 0, 0)).toBeUndefined();
  });

  it('swaps two widgets when the target cell is occupied', () => {
    const layout = defaultLayout(['a', 'b', 'c']);
    const next = moveWidget(layout, 'a', 2, 0); // onto c
    expect(occupantAt(next, 2, 0)?.id).toBe('a');
    expect(occupantAt(next, 0, 0)?.id).toBe('c'); // c took a's old cell
  });

  it('clamps the target column into range and is a no-op onto its own cell', () => {
    const layout = defaultLayout(['a', 'b', 'c']);
    expect(moveWidget(layout, 'a', 99, 0)).toEqual(moveWidget(layout, 'a', DASHBOARD_COLUMNS - 1, 0));
    expect(moveWidget(layout, 'a', 0, 0)).toEqual(layout);
  });

  it('ignores an unknown or hidden id', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('h', 1, 0, false)];
    expect(moveWidget(layout, 'nope', 1, 1)).toEqual(layout);
    expect(moveWidget(layout, 'h', 2, 2)).toEqual(layout);
  });
});

describe('nudgeWidget', () => {
  it('moves one cell in each direction', () => {
    const layout = defaultLayout(['a', 'b', 'c', 'd', 'e', 'f']); // 2 rows of 3
    expect(occupantAt(nudgeWidget(layout, 'e', 'up'), 1, 0)?.id).toBe('e'); // swaps with b
    expect(occupantAt(nudgeWidget(layout, 'a', 'right'), 1, 0)?.id).toBe('a'); // swaps with b
  });

  it('is a no-op past the grid edges', () => {
    const layout = defaultLayout(['a', 'b', 'c']);
    expect(nudgeWidget(layout, 'a', 'up')).toEqual(layout); // y would be -1
    expect(nudgeWidget(layout, 'a', 'left')).toEqual(layout); // x would be -1
    expect(nudgeWidget(layout, 'c', 'right')).toEqual(layout); // x would be 3
  });

  it('nudges down into a fresh empty row', () => {
    const layout = defaultLayout(['a', 'b', 'c']);
    const next = nudgeWidget(layout, 'b', 'down');
    expect(occupantAt(next, 1, 1)?.id).toBe('b');
  });
});

describe('setWidgetVisible', () => {
  it('hides a widget (it stops occupying its cell, keeping its coords)', () => {
    const layout = defaultLayout(['a', 'b']);
    const next = setWidgetVisible(layout, 'b', false);
    expect(next.find((p) => p.id === 'b')?.visible).toBe(false);
    expect(occupantAt(next, 1, 0)).toBeUndefined();
    expect(placedWidgets(next).map((p) => p.id)).toEqual(['a']);
  });

  it('re-shows a hidden widget into the first free cell', () => {
    const layout = setWidgetVisible(defaultLayout(['a', 'b', 'c']), 'b', false);
    // b hidden; (1,0) now free → re-showing reclaims the first free cell.
    const shown = setWidgetVisible(layout, 'b', true);
    expect(shown.find((p) => p.id === 'b')?.visible).toBe(true);
    expect(firstFreeCell(layout)).toEqual({ x: 1, y: 0 });
    expect(occupantAt(shown, 1, 0)?.id).toBe('b');
  });

  it('is a no-op when the visibility already matches or the id is unknown', () => {
    const layout = defaultLayout(['a']);
    expect(setWidgetVisible(layout, 'a', true)).toEqual(layout);
    expect(setWidgetVisible(layout, 'nope', false)).toEqual(layout);
  });
});

describe('reconcileLayout', () => {
  it('returns the default layout when nothing is stored yet', () => {
    expect(reconcileLayout([], ['a', 'b'])).toEqual(defaultLayout(['a', 'b']));
  });

  it('preserves stored coordinates and visibility for known widgets', () => {
    const stored: DashboardLayout = [at('b', 0, 0), at('a', 2, 1, false)];
    const next = reconcileLayout(stored, ['a', 'b']);
    expect(next.find((p) => p.id === 'b')).toEqual(at('b', 0, 0));
    expect(next.find((p) => p.id === 'a')).toEqual(at('a', 2, 1, false));
  });

  it('drops placements whose widget no longer exists in the registry', () => {
    const stored: DashboardLayout = [at('a', 0, 0), at('gone', 1, 0)];
    const next = reconcileLayout(stored, ['a']);
    expect(next.map((p) => p.id)).toEqual(['a']);
  });

  it('appends a newly-registered widget into the first free cell, visible', () => {
    const stored: DashboardLayout = [at('a', 0, 0)];
    const next = reconcileLayout(stored, ['a', 'b']);
    const b = next.find((p) => p.id === 'b');
    expect(b?.visible).toBe(true);
    expect(b).toEqual(at('b', 1, 0)); // first free cell beside a
  });
});
