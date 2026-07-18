import { describe, it, expect } from 'vitest';
import {
  drawReducer,
  initialDrawState,
  MIN_REGION_SIZE,
  POLYGON_CLOSE_DISTANCE,
  type DrawEvent,
  type DrawState,
  type ImageAspect,
} from './draw-machine';
import { boundsOf, circleRadii, type RegionGeometry } from './geometry';

const SQUARE: ImageAspect = { naturalWidth: 1000, naturalHeight: 1000 };
const WIDE: ImageAspect = { naturalWidth: 1600, naturalHeight: 900 };

/** Feed a sequence of events through the reducer. */
function run(state: DrawState, ...events: readonly DrawEvent[]): DrawState {
  return events.reduce(drawReducer, state);
}

/** Drag from `a` to `b`: down, a move, then up. */
function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  down: Partial<DrawEvent> = {},
): DrawEvent[] {
  return [
    { type: 'pointerdown', point: from, ...down } as DrawEvent,
    { type: 'pointermove', point: to },
    { type: 'pointerup', point: to },
  ];
}

const RECT: RegionGeometry = { shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3 };

/** A shape's coordinates in a flat list, for tolerant comparison. */
function coordinates(geometry: RegionGeometry): number[] {
  switch (geometry.shape) {
    case 'rect':
      return [geometry.x, geometry.y, geometry.w, geometry.h];
    case 'circle':
      return [geometry.cx, geometry.cy, geometry.r];
    case 'polygon':
      return geometry.points.flatMap((p) => [p.x, p.y]);
  }
}

/**
 * Assert a geometry, tolerating floating-point drift. The reducer's maths is a chain of
 * subtractions and clamps, so a coordinate that is arithmetically 0.3 routinely arrives as
 * 0.30000000000000004 — exact equality would make these tests assert the IEEE-754 representation
 * rather than the behaviour.
 */
function expectGeometry(actual: RegionGeometry | null, expected: RegionGeometry): void {
  expect(actual).not.toBeNull();
  expect(actual!.shape).toBe(expected.shape);
  const got = coordinates(actual!);
  const want = coordinates(expected);
  expect(got).toHaveLength(want.length);
  got.forEach((n, i) => expect(n).toBeCloseTo(want[i]!, 12));
}

describe('initialDrawState', () => {
  it('rests with nothing selected, drafted or committed', () => {
    const state = initialDrawState('rect', SQUARE);
    expect(state).toEqual({
      tool: 'rect',
      image: SQUARE,
      gesture: { kind: 'idle' },
      draft: null,
      selected: null,
      committed: null,
    });
  });
});

describe('drawing a new rectangle', () => {
  it('previews during the drag and commits on release', () => {
    let state = initialDrawState('rect', SQUARE);
    state = drawReducer(state, { type: 'pointerdown', point: { x: 0.2, y: 0.2 } });
    expect(state.draft).toBeNull(); // no extent yet

    state = drawReducer(state, { type: 'pointermove', point: { x: 0.5, y: 0.6 } });
    expectGeometry(state.draft, { shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.4 });
    expect(state.committed).toBeNull(); // a preview is not a commitment

    state = drawReducer(state, { type: 'pointerup', point: { x: 0.5, y: 0.6 } });
    expectGeometry(state.committed, { shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.4 });
    expect(state.selected).toEqual(state.committed);
    expect(state.draft).toBeNull();
    expect(state.gesture).toEqual({ kind: 'idle' });
  });

  it('drags in any direction (bottom-right to top-left works the same)', () => {
    const state = run(initialDrawState('rect', SQUARE), ...drag({ x: 0.7, y: 0.8 }, { x: 0.3, y: 0.4 }));
    const rect = state.committed as { x: number; y: number; w: number; h: number };
    expect(rect.x).toBeCloseTo(0.3);
    expect(rect.y).toBeCloseTo(0.4);
    expect(rect.w).toBeCloseTo(0.4);
    expect(rect.h).toBeCloseTo(0.4);
  });

  it('clamps a rectangle dragged off the edge back inside the image', () => {
    const state = run(initialDrawState('rect', SQUARE), ...drag({ x: 0.8, y: 0.8 }, { x: 1.4, y: 1.4 }));
    const bounds = boundsOf(state.committed!);
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(1 + 1e-12);
  });
});

describe('drawing a new circle (from the centre outward)', () => {
  it('takes the press as the centre and the release as the edge', () => {
    const state = run(initialDrawState('circle', SQUARE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }));
    expectGeometry(state.committed, { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.2 });
  });

  it('measures the radius in width-normalised units, so a WIDE photo stays circular', () => {
    // Drag straight up on 16:9. The vertical offset must convert through the aspect ratio, or the
    // circle grows faster vertically than horizontally.
    const vertical = run(initialDrawState('circle', WIDE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }));
    const r = (vertical.committed as { r: number }).r;
    // 0.3 of the height on a 16:9 photo is 0.3 * 900/1600 of the width.
    expect(r).toBeCloseTo(0.3 * (900 / 1600), 12);

    // The same physical distance dragged sideways gives the same radius.
    const { rx, ry } = circleRadii(r, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(ry).toBeCloseTo(0.3, 12); // reaches exactly where the pointer was released
    expect(rx).toBeCloseTo(r, 12);
  });

  it('grows equally in every direction on a wide photo (a circle, not an ellipse)', () => {
    const across = run(initialDrawState('circle', WIDE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }));
    const up = run(
      initialDrawState('circle', WIDE),
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 - 0.2 * (1600 / 900) }),
    );
    // The two drags cover the same rendered distance, so they must yield the same radius.
    expect((up.committed as { r: number }).r).toBeCloseTo((across.committed as { r: number }).r, 12);
  });

  it('clamps a circle dragged past the edge without turning it into an ellipse', () => {
    const state = run(initialDrawState('circle', WIDE), ...drag({ x: 0.5, y: 0.5 }, { x: 1.3, y: 0.5 }));
    const bounds = boundsOf(state.committed!, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(bounds.x).toBeGreaterThanOrEqual(-1e-12);
    expect(bounds.y).toBeGreaterThanOrEqual(-1e-12);
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(1 + 1e-12);
  });
});

describe('drawing a new polygon (click per vertex)', () => {
  const A = { x: 0.2, y: 0.2 };
  const B = { x: 0.8, y: 0.2 };
  const C = { x: 0.5, y: 0.8 };

  it('accumulates vertices and previews once it encloses an area', () => {
    let state = initialDrawState('polygon', SQUARE);
    state = drawReducer(state, { type: 'pointerdown', point: A });
    expect(state.draft).toBeNull(); // one point is not a shape
    state = drawReducer(state, { type: 'pointerdown', point: B });
    expect(state.draft).toBeNull();
    state = drawReducer(state, { type: 'pointerdown', point: C });
    expect(state.draft).toEqual({ shape: 'polygon', points: [A, B, C] });
    expect(state.committed).toBeNull(); // still open
  });

  it('closes by clicking the first vertex', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointerdown', point: B },
      { type: 'pointerdown', point: C },
      { type: 'pointerdown', point: { x: A.x + POLYGON_CLOSE_DISTANCE / 2, y: A.y } },
    );
    expect(state.committed).toEqual({ shape: 'polygon', points: [A, B, C] });
    expect(state.gesture).toEqual({ kind: 'idle' });
  });

  it('adds a vertex rather than closing when the click is beyond the close distance', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointerdown', point: B },
      { type: 'pointerdown', point: C },
      { type: 'pointerdown', point: { x: A.x + POLYGON_CLOSE_DISTANCE * 3, y: A.y } },
    );
    expect(state.committed).toBeNull();
    expect(state.gesture).toEqual({
      kind: 'polygon',
      points: [A, B, C, { x: A.x + POLYGON_CLOSE_DISTANCE * 3, y: A.y }],
    });
  });

  it('closes on an explicit finish event', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointerdown', point: B },
      { type: 'pointerdown', point: C },
      { type: 'finish' },
    );
    expect(state.committed).toEqual({ shape: 'polygon', points: [A, B, C] });
  });

  it('refuses to finish with fewer than three vertices', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointerdown', point: B },
      { type: 'finish' },
    );
    expect(state.committed).toBeNull();
    expect(state.gesture).toEqual({ kind: 'idle' });
  });

  it('cannot be closed by re-clicking the first vertex before it encloses an area', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointerdown', point: B },
      { type: 'pointerdown', point: A },
    );
    // The third click adds a vertex; it does not commit a two-point "polygon".
    expect(state.committed).toBeNull();
  });

  it('ignores pointer moves — vertices are placed by clicks', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: A },
      { type: 'pointermove', point: { x: 0.6, y: 0.6 } },
      { type: 'pointerup', point: { x: 0.6, y: 0.6 } },
    );
    expect(state.gesture).toEqual({ kind: 'polygon', points: [A] });
  });
});

describe(`minimum size (${MIN_REGION_SIZE})`, () => {
  it('discards a stray tap rather than creating a zero-area rectangle', () => {
    const state = run(initialDrawState('rect', SQUARE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }));
    expect(state.committed).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.draft).toBeNull();
  });

  it('discards a drag that ends just below the threshold, on either axis', () => {
    const tiny = MIN_REGION_SIZE / 2;
    expect(
      run(initialDrawState('rect', SQUARE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.5 + tiny, y: 0.9 })).committed,
    ).toBeNull();
    expect(
      run(initialDrawState('rect', SQUARE), ...drag({ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 + tiny })).committed,
    ).toBeNull();
  });

  it('accepts a drag exactly at the threshold', () => {
    const state = run(
      initialDrawState('rect', SQUARE),
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.5 + MIN_REGION_SIZE, y: 0.5 + MIN_REGION_SIZE }),
    );
    expect(state.committed).not.toBeNull();
  });

  it('discards a dot of a circle', () => {
    const state = run(
      initialDrawState('circle', SQUARE),
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.5 + MIN_REGION_SIZE / 4, y: 0.5 }),
    );
    expect(state.committed).toBeNull();
  });

  it('discards a collapsed polygon', () => {
    const near = MIN_REGION_SIZE / 4;
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: { x: 0.5, y: 0.5 } },
      { type: 'pointerdown', point: { x: 0.5 + near, y: 0.5 } },
      { type: 'pointerdown', point: { x: 0.5, y: 0.5 + near } },
      { type: 'finish' },
    );
    expect(state.committed).toBeNull();
  });
});

describe('moving an existing shape', () => {
  function selected(tool: 'select' = 'select'): DrawState {
    return drawReducer(initialDrawState(tool, SQUARE), { type: 'select', geometry: RECT });
  }

  it('translates the shape by the drag delta and commits on release', () => {
    const state = run(selected(), ...drag({ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.4 }, { target: 'shape' }));
    expectGeometry(state.committed, { shape: 'rect', x: 0.4, y: 0.3, w: 0.3, h: 0.3 });
    expect(state.selected).toEqual(state.committed);
  });

  it('previews the move without committing until release', () => {
    const state = run(
      selected(),
      { type: 'pointerdown', point: { x: 0.3, y: 0.3 }, target: 'shape' },
      { type: 'pointermove', point: { x: 0.5, y: 0.3 } },
    );
    expectGeometry(state.draft, { shape: 'rect', x: 0.4, y: 0.2, w: 0.3, h: 0.3 });
    expect(state.committed).toBeNull();
    expect(state.selected).toEqual(RECT); // unchanged until commit
  });

  it('keeps the shape inside the image, without shrinking it', () => {
    const state = run(selected(), ...drag({ x: 0.3, y: 0.3 }, { x: 1.5, y: 1.5 }, { target: 'shape' }));
    expectGeometry(state.committed, { shape: 'rect', x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
  });

  it('commits nothing for a move that ends where it started', () => {
    const state = run(selected(), ...drag({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, { target: 'shape' }));
    expect(state.committed).toBeNull();
    expect(state.selected).toEqual(RECT);
  });

  it('clears the selection when the press lands on bare photo', () => {
    const state = drawReducer(selected(), { type: 'pointerdown', point: { x: 0.9, y: 0.9 } });
    expect(state.selected).toBeNull();
  });
});

describe('resizing an existing shape', () => {
  const selectedRect = drawReducer(initialDrawState('select', SQUARE), {
    type: 'select',
    geometry: RECT,
  });

  it('moves the grabbed corner of a rectangle', () => {
    const state = run(
      selectedRect,
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.9 }, { target: 'handle', handle: 'se' }),
    );
    expectGeometry(state.committed, { shape: 'rect', x: 0.2, y: 0.2, w: 0.6, h: 0.7 });
  });

  it('moves only the grabbed edge', () => {
    const state = run(
      selectedRect,
      ...drag({ x: 0.2, y: 0.35 }, { x: 0.05, y: 0.35 }, { target: 'handle', handle: 'w' }),
    );
    const rect = state.committed as { x: number; y: number; w: number; h: number };
    expect(rect.x).toBeCloseTo(0.05, 12);
    expect(rect.y).toBeCloseTo(0.2, 12);
    expect(rect.h).toBeCloseTo(0.3, 12); // untouched axis
  });

  it('flips rather than going negative when a handle is dragged past its opposite edge', () => {
    const state = run(
      selectedRect,
      ...drag({ x: 0.2, y: 0.2 }, { x: 0.9, y: 0.9 }, { target: 'handle', handle: 'nw' }),
    );
    const rect = state.committed as { x: number; y: number; w: number; h: number };
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
    expect(rect.x).toBeCloseTo(0.5, 12);
  });

  it('resizes a circle through its radius handle, staying circular on a wide photo', () => {
    const circle: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.1 };
    const state = run(
      drawReducer(initialDrawState('select', WIDE), { type: 'select', geometry: circle }),
      ...drag({ x: 0.6, y: 0.5 }, { x: 0.7, y: 0.5 }, { target: 'handle', handle: 'radius' }),
    );
    expect((state.committed as { r: number }).r).toBeCloseTo(0.2, 12);
    expect(state.committed!.shape).toBe('circle');
  });

  it('moves a single vertex of a polygon', () => {
    const polygon: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
    };
    const state = run(
      drawReducer(initialDrawState('select', SQUARE), { type: 'select', geometry: polygon }),
      ...drag({ x: 0.8, y: 0.2 }, { x: 0.9, y: 0.1 }, { target: 'handle', handle: 'vertex:1' }),
    );
    expectGeometry(state.committed, {
      shape: 'polygon',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.8 },
      ],
    });
  });

  it('ignores a vertex handle that is out of range', () => {
    const polygon: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
    };
    const state = run(
      drawReducer(initialDrawState('select', SQUARE), { type: 'select', geometry: polygon }),
      ...drag({ x: 0.8, y: 0.2 }, { x: 0.9, y: 0.1 }, { target: 'handle', handle: 'vertex:99' }),
    );
    expect(state.committed).toBeNull(); // no change → nothing to save
    expect(state.selected).toEqual(polygon);
  });

  it("does not let a circle's radius handle drag a rectangle's edge", () => {
    // `'radius'` contains an 's'; a substring-matched handle would move the bottom edge.
    const state = run(
      selectedRect,
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.9 }, { target: 'handle', handle: 'radius' }),
    );
    expect(state.committed).toBeNull();
    expect(state.selected).toEqual(RECT);
  });

  it('discards a resize that collapses the shape below the minimum, restoring it', () => {
    const state = run(
      selectedRect,
      ...drag({ x: 0.5, y: 0.5 }, { x: 0.205, y: 0.205 }, { target: 'handle', handle: 'se' }),
    );
    expect(state.committed).toBeNull();
    expect(state.selected).toEqual(RECT);
    expect(state.draft).toBeNull();
  });
});

describe('abort (Escape / pointer cancel)', () => {
  it('throws away an in-progress new shape', () => {
    const state = run(
      initialDrawState('rect', SQUARE),
      { type: 'pointerdown', point: { x: 0.2, y: 0.2 } },
      { type: 'pointermove', point: { x: 0.6, y: 0.6 } },
      { type: 'cancel' },
    );
    expect(state.draft).toBeNull();
    expect(state.committed).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.gesture).toEqual({ kind: 'idle' });
  });

  it('restores the pre-drag geometry of a shape being moved', () => {
    const state = run(
      drawReducer(initialDrawState('select', SQUARE), { type: 'select', geometry: RECT }),
      { type: 'pointerdown', point: { x: 0.3, y: 0.3 }, target: 'shape' },
      { type: 'pointermove', point: { x: 0.8, y: 0.8 } },
      { type: 'cancel' },
    );
    expect(state.selected).toEqual(RECT);
    expect(state.draft).toBeNull();
    expect(state.committed).toBeNull();
  });

  it('restores the pre-drag geometry of a shape being resized', () => {
    const state = run(
      drawReducer(initialDrawState('select', SQUARE), { type: 'select', geometry: RECT }),
      { type: 'pointerdown', point: { x: 0.5, y: 0.5 }, target: 'handle', handle: 'se' },
      { type: 'pointermove', point: { x: 0.95, y: 0.95 } },
      { type: 'cancel' },
    );
    expect(state.selected).toEqual(RECT);
  });

  it('abandons a half-drawn polygon', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: { x: 0.2, y: 0.2 } },
      { type: 'pointerdown', point: { x: 0.8, y: 0.2 } },
      { type: 'cancel' },
    );
    expect(state.gesture).toEqual({ kind: 'idle' });
    expect(state.draft).toBeNull();
  });

  it('is a harmless no-op when nothing is in flight', () => {
    const idle = initialDrawState('rect', SQUARE);
    expect(drawReducer(idle, { type: 'cancel' })).toEqual(idle);
  });
});

describe('committed is a one-shot output', () => {
  it('clears on the very next event, so a caller cannot save twice', () => {
    const committedState = run(
      initialDrawState('rect', SQUARE),
      ...drag({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }),
    );
    expect(committedState.committed).not.toBeNull();
    expect(
      drawReducer(committedState, { type: 'pointermove', point: { x: 0.1, y: 0.1 } }).committed,
    ).toBeNull();
    expect(drawReducer(committedState, { type: 'cancel' }).committed).toBeNull();
    expect(drawReducer(committedState, { type: 'tool', tool: 'circle' }).committed).toBeNull();
  });
});

describe('switching tool', () => {
  it('abandons a half-drawn polygon', () => {
    const state = run(
      initialDrawState('polygon', SQUARE),
      { type: 'pointerdown', point: { x: 0.2, y: 0.2 } },
      { type: 'pointerdown', point: { x: 0.8, y: 0.2 } },
      { type: 'tool', tool: 'rect' },
    );
    expect(state.tool).toBe('rect');
    expect(state.gesture).toEqual({ kind: 'idle' });
    expect(state.draft).toBeNull();
  });

  it('keeps the current selection (switching tools is not deselecting)', () => {
    const state = run(drawReducer(initialDrawState('select', SQUARE), { type: 'select', geometry: RECT }), {
      type: 'tool',
      tool: 'circle',
    });
    expect(state.selected).toEqual(RECT);
  });
});

describe('the reducer is pure', () => {
  it('never mutates the state it is given', () => {
    const state = initialDrawState('rect', SQUARE);
    const snapshot = structuredClone(state);
    run(state, ...drag({ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 }));
    expect(state).toEqual(snapshot);
  });
});
