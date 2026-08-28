import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_COLUMNS,
  defaultLayout,
  firstFreeCell,
  hideHealthyCards,
  moveWidget,
  nudgeWidget,
  occupantAt,
  placedWidgets,
  reconcileLayout,
  resizeWidget,
  setWidgetVisible,
  MAX_WIDGET_HEIGHT,
  MAX_WIDGET_WIDTH,
  WIDGET_SIZE_OPTIONS,
  type DashboardLayout,
} from './dashboard-layout';

/** Compact helper: a visible 1x1 placement at (x, y). */
function at(id: string, x: number, y: number, visible = true) {
  return { id, x, y, w: 1, h: 1, visible };
}

/** Compact helper: a visible placement at (x, y) spanning w x h cells (issue #441). */
function span(id: string, x: number, y: number, w: number, h: number, visible = true) {
  return { id, x, y, w, h, visible };
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

describe('hideHealthyCards', () => {
  it('returns the same reference when nothing is hidden (no-op fast path)', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('b', 1, 0)];
    expect(hideHealthyCards(layout, new Set())).toBe(layout);
  });

  it('drops the hidden cards and re-flows the survivors gaplessly row-major', () => {
    // a b c on the top row, d e on the next; hide b and d — c, e should close the gaps.
    const layout: DashboardLayout = [
      at('a', 0, 0),
      at('b', 1, 0),
      at('c', 2, 0),
      at('d', 0, 1),
      at('e', 1, 1),
    ];
    const result = hideHealthyCards(layout, new Set(['b', 'd']));
    expect(result).toEqual([at('a', 0, 0), at('c', 1, 0), at('e', 2, 0)]);
  });

  it('preserves the visible row-major order of the survivors when re-flowing', () => {
    // Deliberately out of array order; placedWidgets sorts by (row, col) first.
    const layout: DashboardLayout = [at('c', 2, 0), at('a', 0, 0), at('b', 1, 0)];
    expect(hideHealthyCards(layout, new Set(['a'])).map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('never re-flows an already-hidden (customise-hidden) placement onto the board', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('hidden', 1, 0, false), at('b', 2, 0)];
    // Only the visible survivors are packed; the customise-hidden one stays off the board.
    expect(hideHealthyCards(layout, new Set(['a']))).toEqual([at('b', 0, 0)]);
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

  // Issue #627: a board arranged by an older build — or synced in from a device running a
  // leaner module set — can already stack two visible widgets in one cell, which draws one
  // tile over the other. Reading it repairs it.
  it('re-homes a second widget stacked in an already-occupied cell', () => {
    const stored: DashboardLayout = [at('a', 0, 0), at('b', 0, 0), at('c', 2, 0)];
    const next = reconcileLayout(stored, ['a', 'b', 'c']);
    // The first claimant keeps the cell; the later one takes the first genuinely free one.
    expect(next).toEqual([at('a', 0, 0), at('b', 1, 0), at('c', 2, 0)]);
  });

  it('gives two widgets stacked on one cell different homes, and spills onto the next row', () => {
    const stored: DashboardLayout = [
      at('a', 0, 0),
      at('b', 0, 0),
      at('c', 0, 0),
      at('d', 1, 0),
      at('e', 2, 0),
    ];
    const next = reconcileLayout(stored, ['a', 'b', 'c', 'd', 'e']);
    expect(next).toEqual([at('a', 0, 0), at('b', 0, 1), at('c', 1, 1), at('d', 1, 0), at('e', 2, 0)]);
  });

  it('ignores a hidden placement sharing a visible widget’s cell (it occupies nothing)', () => {
    const stored: DashboardLayout = [at('a', 0, 0), at('b', 0, 0, false)];
    const next = reconcileLayout(stored, ['a', 'b']);
    expect(next).toEqual(stored);
  });
});

// --- Resizable cards (issue #441) ----------------------------------------------------

describe('WIDGET_SIZE_OPTIONS', () => {
  it('offers every span up to the caps, once each', () => {
    expect(WIDGET_SIZE_OPTIONS).toHaveLength(MAX_WIDGET_WIDTH * MAX_WIDGET_HEIGHT);
    const keys = WIDGET_SIZE_OPTIONS.map((o) => `${o.w}x${o.h}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('1x1');
    expect(keys).toContain(`${MAX_WIDGET_WIDTH}x${MAX_WIDGET_HEIGHT}`);
  });
});

describe('occupantAt with spans', () => {
  it('reports a multi-cell widget as the occupant of every cell it covers', () => {
    const layout: DashboardLayout = [span('big', 0, 0, 2, 2)];
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      expect(occupantAt(layout, x!, y!)?.id).toBe('big');
    }
    expect(occupantAt(layout, 2, 0)).toBeUndefined();
    expect(occupantAt(layout, 0, 2)).toBeUndefined();
  });
});

describe('firstFreeCell with spans', () => {
  it('skips a hole too narrow for the rectangle being placed', () => {
    // (0,0) taken, (1,0)-(2,0) free: a 1-wide fits at (1,0), and so does a 2-wide.
    expect(firstFreeCell([at('a', 0, 0)], 1, 1)).toEqual({ x: 1, y: 0 });
    expect(firstFreeCell([at('a', 0, 0)], 2, 1)).toEqual({ x: 1, y: 0 });
    // (0,0) and (2,0) taken: only the single middle cell is free, so a 2-wide spills a row.
    const pocket: DashboardLayout = [at('a', 0, 0), at('c', 2, 0)];
    expect(firstFreeCell(pocket, 1, 1)).toEqual({ x: 1, y: 0 });
    expect(firstFreeCell(pocket, 2, 1)).toEqual({ x: 0, y: 1 });
  });

  it('never starts a 2-wide rectangle in the last column', () => {
    expect(firstFreeCell([at('a', 0, 0), at('b', 1, 0)], 2, 1)).toEqual({ x: 0, y: 1 });
  });

  it('needs both rows free for a 2-tall rectangle', () => {
    expect(firstFreeCell([at('a', 0, 1)], 1, 2)).toEqual({ x: 1, y: 0 });
  });
});

describe('resizeWidget', () => {
  it('grows a widget into free space', () => {
    const layout: DashboardLayout = [at('a', 0, 0)];
    expect(resizeWidget(layout, 'a', 2, 2)).toEqual([span('a', 0, 0, 2, 2)]);
  });

  it('refuses a grow that would overlap a neighbour, returning the same reference', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('b', 1, 0)];
    expect(resizeWidget(layout, 'a', 2, 1)).toBe(layout);
  });

  it('refuses a grow blocked only on the row below', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('b', 0, 1)];
    expect(resizeWidget(layout, 'a', 1, 2)).toBe(layout);
  });

  it('shifts a widget in the last column left rather than running off the board', () => {
    const layout: DashboardLayout = [at('a', 2, 0)];
    expect(resizeWidget(layout, 'a', 2, 1)).toEqual([span('a', 1, 0, 2, 1)]);
  });

  it('still refuses that leftward shift when the cell it would move into is taken', () => {
    const layout: DashboardLayout = [at('a', 2, 0), at('b', 1, 0)];
    expect(resizeWidget(layout, 'a', 2, 1)).toBe(layout);
  });

  it('clamps an out-of-range span into the allowed sizes', () => {
    const layout: DashboardLayout = [at('a', 0, 0)];
    expect(resizeWidget(layout, 'a', 99, 0)).toEqual([span('a', 0, 0, MAX_WIDGET_WIDTH, 1)]);
  });

  it('is a no-op for the size it already has, an unknown id, or a hidden widget', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('h', 1, 0, false)];
    expect(resizeWidget(layout, 'a', 1, 1)).toBe(layout);
    expect(resizeWidget(layout, 'nope', 2, 2)).toBe(layout);
    expect(resizeWidget(layout, 'h', 2, 2)).toBe(layout);
  });

  it('shrinks back down, freeing the cells it held', () => {
    const grown: DashboardLayout = [span('a', 0, 0, 2, 2)];
    const shrunk = resizeWidget(grown, 'a', 1, 1);
    expect(shrunk).toEqual([at('a', 0, 0)]);
    expect(occupantAt(shrunk, 1, 0)).toBeUndefined();
  });
});

describe('moveWidget with spans', () => {
  it('swaps two widgets of the same size, as it always has', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 2, 1), span('b', 0, 1, 2, 1)];
    expect(moveWidget(layout, 'a', 0, 1)).toEqual([span('a', 0, 1, 2, 1), span('b', 0, 0, 2, 1)]);
  });

  it('refuses a move onto a differently-sized neighbour rather than guessing', () => {
    const layout: DashboardLayout = [at('a', 0, 0), span('b', 0, 1, 2, 1)];
    expect(moveWidget(layout, 'a', 0, 1)).toBe(layout);
  });

  it('refuses a move that would land across two widgets at once', () => {
    const layout: DashboardLayout = [span('wide', 0, 0, 2, 1), at('b', 0, 1), at('c', 1, 1)];
    expect(moveWidget(layout, 'wide', 0, 1)).toBe(layout);
  });

  it('clamps a 2-wide widget so it cannot start in the last column', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 2, 1)];
    // Asking for column 2 lands on column 1 — the furthest right it fits.
    expect(moveWidget(layout, 'a', 2, 0)).toEqual([span('a', 1, 0, 2, 1)]);
  });

  it('stops a 2-wide widget nudging off the right edge', () => {
    const layout: DashboardLayout = [span('a', 1, 0, 2, 1)];
    expect(nudgeWidget(layout, 'a', 'right')).toBe(layout);
  });
});

describe('setWidgetVisible with spans', () => {
  it('re-shows a wide widget in the first cell its whole rectangle fits', () => {
    const layout: DashboardLayout = [at('a', 0, 0), at('c', 2, 0), span('wide', 0, 5, 2, 1, false)];
    const next = setWidgetVisible(layout, 'wide', true);
    // (1,0) is free but only one cell wide, so the 2-wide card takes the next row.
    expect(next.find((p) => p.id === 'wide')).toEqual(span('wide', 0, 1, 2, 1));
  });
});

describe('hideHealthyCards with spans', () => {
  it('repacks the survivors, each keeping its own size', () => {
    const layout: DashboardLayout = [at('a', 0, 0), span('wide', 1, 0, 2, 1), at('c', 0, 1)];
    expect(hideHealthyCards(layout, new Set(['a']))).toEqual([span('wide', 0, 0, 2, 1), at('c', 2, 0)]);
  });
});

describe('reconcileLayout with spans', () => {
  it('gives a layout stored before resizing existed a 1x1 span', () => {
    // Exactly the shape an older build persisted: no `w`/`h` at all.
    const stored = [{ id: 'a', x: 0, y: 0, visible: true }] as unknown as DashboardLayout;
    expect(reconcileLayout(stored, ['a'])).toEqual([at('a', 0, 0)]);
  });

  it('clamps a nonsense stored span and pulls the widget back onto the board', () => {
    const stored = [{ id: 'a', x: 2, y: 0, w: 9, h: -3, visible: true }] as unknown as DashboardLayout;
    expect(reconcileLayout(stored, ['a'])).toEqual([
      span('a', DASHBOARD_COLUMNS - MAX_WIDGET_WIDTH, 0, MAX_WIDGET_WIDTH, 1),
    ]);
  });

  it('repairs a stored layout whose widgets overlap only because of their spans', () => {
    const stored: DashboardLayout = [span('a', 0, 0, 2, 1), at('b', 1, 0)];
    const next = reconcileLayout(stored, ['a', 'b']);
    expect(next.find((p) => p.id === 'a')).toEqual(span('a', 0, 0, 2, 1));
    expect(next.find((p) => p.id === 'b')).toEqual(at('b', 2, 0));
  });

  it('leaves a well-formed sized layout exactly as stored', () => {
    const stored: DashboardLayout = [span('a', 0, 0, 2, 2), at('b', 2, 0), at('c', 2, 1)];
    expect(reconcileLayout(stored, ['a', 'b', 'c'])).toEqual(stored);
  });
});

describe('moveWidget — a swap must fully vacate the subject cells', () => {
  // A swap hands the occupant the subject's old rectangle. A multi-cell card nudged by less than
  // its own span is still standing in part of that rectangle, so the two would end up on top of
  // each other — the stacked-unreadable-tile state the board exists to prevent.
  it('refuses a one-row nudge that would land a swapped 1x2 card back under the subject', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 1, 2), span('b', 0, 2, 1, 2)];
    expect(moveWidget(layout, 'a', 0, 1)).toBe(layout);
  });

  it('refuses a one-column nudge that would land a swapped 2x1 card back under the subject', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 2, 1), span('b', 0, 1, 2, 1)];
    // Moving 'a' one column right overlaps nothing on its own row, so this is a plain move.
    expect(moveWidget(layout, 'a', 1, 0)).toEqual([span('a', 1, 0, 2, 1), span('b', 0, 1, 2, 1)]);
  });

  it('refuses a one-row nudge that would land a swapped 2x2 card back under the subject', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 2, 2), span('b', 0, 2, 2, 2)];
    expect(moveWidget(layout, 'a', 0, 1)).toBe(layout);
  });

  it('still swaps two multi-cell cards whose rectangles do not overlap', () => {
    const layout: DashboardLayout = [span('a', 0, 0, 1, 2), span('b', 1, 0, 1, 2)];
    expect(moveWidget(layout, 'a', 1, 0)).toEqual([span('a', 1, 0, 1, 2), span('b', 0, 0, 1, 2)]);
  });

  it('leaves no two visible cards sharing a cell after any single-step nudge', () => {
    // Drive every direction from every card of a mixed-size board and assert the invariant the
    // whole module exists to hold: one card per cell.
    const start: DashboardLayout = [
      span('tall', 0, 0, 1, 2),
      span('wide', 1, 0, 2, 1),
      span('big', 1, 1, 2, 2),
      span('small', 0, 2, 1, 1),
    ];
    const dirs = ['up', 'down', 'left', 'right'] as const;
    for (const p of start) {
      for (const dir of dirs) {
        const next = nudgeWidget(start, p.id, dir);
        const cells = next
          .filter((q) => q.visible)
          .flatMap((q) =>
            Array.from({ length: q.w * q.h }, (_, i) => `${q.x + (i % q.w)},${q.y + Math.floor(i / q.w)}`),
          );
        expect(new Set(cells).size, `${p.id} nudged ${dir}`).toBe(cells.length);
      }
    }
  });
});
