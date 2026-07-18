import { describe, it, expect } from 'vitest';
import { geometryContains, hitTest, type HitTestRegion } from './hit-test';
import { circleRadii, type RegionGeometry } from './geometry';

const WIDE = { naturalWidth: 1600, naturalHeight: 900 };
const TALL = { naturalWidth: 900, naturalHeight: 1600 };

const RECT: RegionGeometry = { shape: 'rect', x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
const CIRCLE: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.2 };

/** An L-shaped (concave) polygon occupying the top-left, with its notch at the bottom-right. */
const CONCAVE: RegionGeometry = {
  shape: 'polygon',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.3 },
    { x: 0.3, y: 0.3 },
    { x: 0.3, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ],
};

/** Build a region row for {@link hitTest}. */
function region(id: string, geometry: RegionGeometry, position: number) {
  return { id, geometry, position };
}

describe('geometryContains — rectangles', () => {
  it('accepts interior points and rejects exterior ones', () => {
    expect(geometryContains(RECT, { x: 0.4, y: 0.4 })).toBe(true);
    expect(geometryContains(RECT, { x: 0.1, y: 0.4 })).toBe(false);
    expect(geometryContains(RECT, { x: 0.4, y: 0.9 })).toBe(false);
  });

  it('treats every edge and corner as inside', () => {
    for (const point of [
      { x: 0.2, y: 0.2 }, // top-left corner
      { x: 0.6, y: 0.6 }, // bottom-right corner
      { x: 0.2, y: 0.4 }, // left edge
      { x: 0.4, y: 0.6 }, // bottom edge
    ]) {
      expect(geometryContains(RECT, point)).toBe(true);
    }
  });

  it('rejects a non-finite point rather than reporting a spurious hit', () => {
    expect(geometryContains(RECT, { x: Number.NaN, y: 0.4 })).toBe(false);
    expect(geometryContains(RECT, { x: 0.4, y: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('geometryContains — circles (the aspect correction applies here too)', () => {
  it('accepts the centre and rejects a far corner on a square photo', () => {
    expect(geometryContains(CIRCLE, { x: 0.5, y: 0.5 }, 1000, 1000)).toBe(true);
    expect(geometryContains(CIRCLE, { x: 0.05, y: 0.05 }, 1000, 1000)).toBe(false);
  });

  it('tests the ellipse actually rendered on a WIDE photo, not a normalised-space circle', () => {
    const { rx, ry } = circleRadii(0.2, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(ry).toBeGreaterThan(rx); // wide photo: taller in normalised terms
    // A point below the centre by more than rx but less than ry is inside the drawn ellipse — a
    // naive circle test using r on both axes would wrongly miss it.
    const y = 0.5 + (rx + ry) / 2;
    expect(geometryContains(CIRCLE, { x: 0.5, y }, WIDE.naturalWidth, WIDE.naturalHeight)).toBe(true);
    // ...and just beyond ry is outside.
    expect(
      geometryContains(CIRCLE, { x: 0.5, y: 0.5 + ry + 0.01 }, WIDE.naturalWidth, WIDE.naturalHeight),
    ).toBe(false);
  });

  it('tests the ellipse actually rendered on a TALL photo', () => {
    const { rx, ry } = circleRadii(0.2, TALL.naturalWidth, TALL.naturalHeight);
    expect(ry).toBeLessThan(rx); // tall photo: shorter in normalised terms
    expect(
      geometryContains(CIRCLE, { x: 0.5, y: 0.5 + (rx + ry) / 2 }, TALL.naturalWidth, TALL.naturalHeight),
    ).toBe(false);
    expect(
      geometryContains(CIRCLE, { x: 0.5 + (rx + ry) / 2, y: 0.5 }, TALL.naturalWidth, TALL.naturalHeight),
    ).toBe(true);
  });

  it('treats a point exactly on the perimeter as inside', () => {
    const { rx, ry } = circleRadii(0.2, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(geometryContains(CIRCLE, { x: 0.5 + rx, y: 0.5 }, WIDE.naturalWidth, WIDE.naturalHeight)).toBe(
      true,
    );
    expect(geometryContains(CIRCLE, { x: 0.5, y: 0.5 + ry }, WIDE.naturalWidth, WIDE.naturalHeight)).toBe(
      true,
    );
  });

  it('rejects everything for a degenerate radius', () => {
    const dot: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0 };
    expect(geometryContains(dot, { x: 0.5, y: 0.5 })).toBe(false);
  });
});

describe('geometryContains — polygons (even-odd ray casting)', () => {
  it('accepts a point in the body of a convex polygon', () => {
    const triangle: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.9 },
      ],
    };
    expect(geometryContains(triangle, { x: 0.5, y: 0.3 })).toBe(true);
    expect(geometryContains(triangle, { x: 0.15, y: 0.8 })).toBe(false); // outside the slope
  });

  it('handles a CONCAVE polygon: the notch is outside even though it is within the bounds', () => {
    // Inside the L's two arms.
    expect(geometryContains(CONCAVE, { x: 0.5, y: 0.2 })).toBe(true);
    expect(geometryContains(CONCAVE, { x: 0.2, y: 0.7 })).toBe(true);
    // The notch — inside the bounding box, outside the shape. A convex-only test fails here.
    expect(geometryContains(CONCAVE, { x: 0.7, y: 0.7 })).toBe(false);
    expect(geometryContains(CONCAVE, { x: 0.5, y: 0.5 })).toBe(false);
  });

  it('handles a self-crossing polygon by the even-odd rule (matching SVG fill)', () => {
    // A bow-tie whose two filled lobes point left and right from the crossing at the centre.
    const bowTie: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.9 },
      ],
    };
    expect(geometryContains(bowTie, { x: 0.2, y: 0.5 })).toBe(true); // left lobe
    expect(geometryContains(bowTie, { x: 0.8, y: 0.5 })).toBe(true); // right lobe
    expect(geometryContains(bowTie, { x: 0.5, y: 0.2 })).toBe(false); // between the lobes
  });

  it('treats points exactly ON an edge as inside — every edge, deterministically', () => {
    const square: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
    };
    // Top and bottom are the pair a bare half-open ray cast disagrees on; both must be inside.
    expect(geometryContains(square, { x: 0.5, y: 0.2 })).toBe(true); // top edge
    expect(geometryContains(square, { x: 0.5, y: 0.8 })).toBe(true); // bottom edge
    expect(geometryContains(square, { x: 0.2, y: 0.5 })).toBe(true); // left edge
    expect(geometryContains(square, { x: 0.8, y: 0.5 })).toBe(true); // right edge
  });

  it('treats every vertex as inside', () => {
    for (const vertex of CONCAVE.shape === 'polygon' ? CONCAVE.points : []) {
      expect(geometryContains(CONCAVE, vertex)).toBe(true);
    }
  });

  it('is deterministic on a diagonal edge', () => {
    const triangle: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    };
    expect(geometryContains(triangle, { x: 0.5, y: 0.5 })).toBe(true); // on the hypotenuse
    expect(geometryContains(triangle, { x: 0.25, y: 0.25 })).toBe(true);
    expect(geometryContains(triangle, { x: 0.6, y: 0.5 })).toBe(false); // just outside it
  });

  it('rejects a degenerate polygon with fewer than three points', () => {
    const line = {
      shape: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    } as RegionGeometry;
    expect(geometryContains(line, { x: 0.5, y: 0.5 })).toBe(false);
  });
});

describe('hitTest — topmost region wins', () => {
  it('returns null when the point is over bare photo', () => {
    expect(hitTest([region('a', RECT, 0)], { x: 0.95, y: 0.95 })).toBeNull();
    expect(hitTest([], { x: 0.5, y: 0.5 })).toBeNull();
  });

  it('returns the matching region row itself, not just its geometry', () => {
    const rows = [region('a', RECT, 0)];
    expect(hitTest(rows, { x: 0.4, y: 0.4 })?.id).toBe('a');
  });

  it('resolves overlapping shapes by position DESCENDING', () => {
    const under = region('under', RECT, 1);
    const over = region('over', { shape: 'rect', x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, 5);
    // Array order deliberately puts the lower-position region last, so only `position` can decide.
    expect(hitTest([over, under], { x: 0.4, y: 0.4 })?.id).toBe('over');
    expect(hitTest([under, over], { x: 0.4, y: 0.4 })?.id).toBe('over');
    // A point only the lower region covers still hits it.
    expect(hitTest([over, under], { x: 0.25, y: 0.25 })?.id).toBe('under');
  });

  it('breaks a position tie by later array order (painter last-drawn-wins)', () => {
    const first = region('first', RECT, 0);
    const second = region('second', RECT, 0);
    expect(hitTest([first, second], { x: 0.4, y: 0.4 })?.id).toBe('second');
    expect(hitTest([second, first], { x: 0.4, y: 0.4 })?.id).toBe('first');
  });

  it('mixes shapes and applies each ones own containment maths', () => {
    const rows = [
      region('rect', RECT, 0),
      region('circle', { shape: 'circle', cx: 0.8, cy: 0.8, r: 0.1 }, 1),
      region('poly', CONCAVE, 2),
    ];
    expect(hitTest(rows, { x: 0.8, y: 0.8 }, 1000, 1000)?.id).toBe('circle');
    expect(hitTest(rows, { x: 0.15, y: 0.85 }, 1000, 1000)?.id).toBe('poly');
    // The polygon's notch falls through to the rectangle beneath it.
    expect(hitTest(rows, { x: 0.45, y: 0.45 }, 1000, 1000)?.id).toBe('rect');
  });

  it('passes the natural dimensions through to the circle test', () => {
    const rows: HitTestRegion[] = [{ geometry: CIRCLE, position: 0 }];
    const { ry } = circleRadii(0.2, WIDE.naturalWidth, WIDE.naturalHeight);
    const point = { x: 0.5, y: 0.5 + ry - 0.01 };
    expect(hitTest(rows, point, WIDE.naturalWidth, WIDE.naturalHeight)).not.toBeNull();
    // The same point against a square photo is outside — proving the dimensions are used.
    expect(hitTest(rows, point, 1000, 1000)).toBeNull();
  });

  it('does not mutate or reorder the caller array', () => {
    const rows = [region('a', RECT, 0), region('b', RECT, 9)];
    const snapshot = [...rows];
    hitTest(rows, { x: 0.4, y: 0.4 });
    expect(rows).toEqual(snapshot);
  });
});
