import { describe, it, expect } from 'vitest';
import {
  applyRegionKey,
  resolveRegionKey,
  COARSE_NUDGE_STEP,
  NUDGE_STEP,
  type RegionKeyAction,
} from './region-keyboard';
import { boundsOf, type RegionGeometry } from './geometry';
import { MIN_REGION_SIZE } from './draw-machine';

/** A 16:9 landscape photo — the aspect the circle rules must survive. */
const WIDE = { naturalWidth: 1600, naturalHeight: 900 };

const RECT: RegionGeometry = { shape: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
const CIRCLE: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.1 };
const TRIANGLE: RegionGeometry = {
  shape: 'polygon',
  points: [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.5, y: 0.6 },
  ],
};

describe('resolveRegionKey — what a key means', () => {
  it('maps each arrow to a nudge of one fine step along its own axis', () => {
    expect(resolveRegionKey('ArrowRight')).toEqual({ kind: 'nudge', dx: NUDGE_STEP, dy: 0 });
    expect(resolveRegionKey('ArrowLeft')).toEqual({ kind: 'nudge', dx: -NUDGE_STEP, dy: 0 });
    // y grows downward, so ArrowUp is negative.
    expect(resolveRegionKey('ArrowUp')).toEqual({ kind: 'nudge', dx: 0, dy: -NUDGE_STEP });
    expect(resolveRegionKey('ArrowDown')).toEqual({ kind: 'nudge', dx: 0, dy: NUDGE_STEP });
  });

  it('switches from nudging to resizing under Shift, keeping the same step', () => {
    expect(resolveRegionKey('ArrowRight', { shift: true })).toEqual({
      kind: 'resize',
      dx: NUDGE_STEP,
      dy: 0,
    });
    expect(resolveRegionKey('ArrowUp', { shift: true })).toEqual({
      kind: 'resize',
      dx: 0,
      dy: -NUDGE_STEP,
    });
  });

  it('switches to the coarse step under Ctrl/Cmd, for both nudge and resize', () => {
    expect(resolveRegionKey('ArrowDown', { coarse: true })).toEqual({
      kind: 'nudge',
      dx: 0,
      dy: COARSE_NUDGE_STEP,
    });
    expect(resolveRegionKey('ArrowDown', { coarse: true, shift: true })).toEqual({
      kind: 'resize',
      dx: 0,
      dy: COARSE_NUDGE_STEP,
    });
  });

  it('activates on Enter and Space, per the role="button" contract', () => {
    expect(resolveRegionKey('Enter')).toEqual({ kind: 'activate' });
    expect(resolveRegionKey(' ')).toEqual({ kind: 'activate' });
  });

  it('cancels on Escape', () => {
    expect(resolveRegionKey('Escape')).toEqual({ kind: 'cancel' });
  });

  it('returns null for keys it does not own, so Tab and typing still work', () => {
    // Swallowing these would trap focus on the canvas — the one thing an a11y path must not do.
    expect(resolveRegionKey('Tab')).toBeNull();
    expect(resolveRegionKey('a')).toBeNull();
    expect(resolveRegionKey('Home')).toBeNull();
    expect(resolveRegionKey('PageDown')).toBeNull();
  });
});

describe('applyRegionKey — nudging', () => {
  it('translates a rectangle without changing its size', () => {
    const moved = applyRegionKey(RECT, { kind: 'nudge', dx: 0.1, dy: -0.05 }, ...axes(WIDE));
    expect(moved).toEqual({ shape: 'rect', x: 0.5, y: expect.closeTo(0.35, 10), w: 0.2, h: 0.2 });
  });

  it('translates a circle and a polygon by the same delta', () => {
    const circle = applyRegionKey(CIRCLE, { kind: 'nudge', dx: 0.1, dy: 0 }, ...axes(WIDE));
    expect(circle).toMatchObject({ shape: 'circle', cx: expect.closeTo(0.6, 10), r: 0.1 });

    const polygon = applyRegionKey(TRIANGLE, { kind: 'nudge', dx: 0, dy: 0.1 }, ...axes(WIDE));
    expect(boundsOf(polygon).y).toBeCloseTo(0.5);
  });

  it('parks a region against the edge rather than letting it slide off the photo', () => {
    const atEdge: RegionGeometry = { shape: 'rect', x: 0.95, y: 0.2, w: 0.05, h: 0.2 };
    const moved = applyRegionKey(atEdge, { kind: 'nudge', dx: COARSE_NUDGE_STEP, dy: 0 }, ...axes(WIDE));
    // Clamped flush to the right edge, at its original size — translated, not squashed.
    expect(moved).toMatchObject({ shape: 'rect', x: expect.closeTo(0.95, 10), w: 0.05 });
  });
});

describe('applyRegionKey — resizing', () => {
  it('grows a rectangle toward the bottom-right, holding its top-left corner', () => {
    const grown = applyRegionKey(RECT, { kind: 'resize', dx: 0.1, dy: 0.05 }, ...axes(WIDE));
    expect(grown).toEqual({
      shape: 'rect',
      x: 0.4,
      y: 0.4,
      w: expect.closeTo(0.3, 10),
      h: expect.closeTo(0.25, 10),
    });
  });

  it('shrinks a rectangle on the opposite arrows', () => {
    const shrunk = applyRegionKey(RECT, { kind: 'resize', dx: -0.05, dy: 0 }, ...axes(WIDE));
    expect(shrunk).toMatchObject({ w: expect.closeTo(0.15, 10), h: 0.2 });
  });

  it('never shrinks below the minimum region size, so a region stays selectable', () => {
    const shrunk = applyRegionKey(RECT, { kind: 'resize', dx: -1, dy: -1 }, ...axes(WIDE));
    const bounds = boundsOf(shrunk, ...axes(WIDE));
    expect(bounds.w).toBeGreaterThanOrEqual(MIN_REGION_SIZE - 1e-9);
    expect(bounds.h).toBeGreaterThanOrEqual(MIN_REGION_SIZE - 1e-9);
  });

  it('grows a circle by its radius while holding its bounding box top-left', () => {
    const before = boundsOf(CIRCLE, ...axes(WIDE));
    const grown = applyRegionKey(CIRCLE, { kind: 'resize', dx: 0.05, dy: 0 }, ...axes(WIDE));
    expect(grown).toMatchObject({ shape: 'circle', r: expect.closeTo(0.15, 10) });
    const after = boundsOf(grown, ...axes(WIDE));
    // The anchor is what makes the keyboard agree with dragging the `se` handle.
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('keeps a circle circular on a non-square photo (the aspect trap)', () => {
    const grown = applyRegionKey(CIRCLE, { kind: 'resize', dx: 0.05, dy: 0 }, ...axes(WIDE));
    // `r` is width-normalised, so the vertical extent must come out wider in normalised units
    // on a landscape photo — equal extents here would mean the correction had been skipped.
    const bounds = boundsOf(grown, ...axes(WIDE));
    expect(bounds.h).toBeGreaterThan(bounds.w);
  });

  it('scales a polygon about its bounding-box top-left, preserving its proportions', () => {
    const grown = applyRegionKey(TRIANGLE, { kind: 'resize', dx: 0.2, dy: 0 }, ...axes(WIDE));
    const bounds = boundsOf(grown);
    expect(bounds.x).toBeCloseTo(0.4);
    expect(bounds.w).toBeCloseTo(0.4);
    expect(bounds.h).toBeCloseTo(0.2); // untouched axis
    if (grown.shape !== 'polygon') throw new Error('expected a polygon');
    // The apex stays proportionally centred rather than being dragged to a corner.
    expect(grown.points[2]!.x).toBeCloseTo(0.6);
  });

  it('leaves a degenerate polygon alone rather than scaling by infinity', () => {
    const flat: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ],
    };
    const result = applyRegionKey(flat, { kind: 'resize', dx: 0.1, dy: 0.1 }, ...axes(WIDE));
    if (result.shape !== 'polygon') throw new Error('expected a polygon');
    expect(result.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

describe('applyRegionKey — the non-geometric actions', () => {
  it.each<RegionKeyAction>([{ kind: 'activate' }, { kind: 'cancel' }])(
    'returns the geometry unchanged for %o',
    (action) => {
      expect(applyRegionKey(RECT, action, ...axes(WIDE))).toBe(RECT);
    },
  );
});

/** Spread a photo's intrinsic size into the positional `(naturalWidth, naturalHeight)` pair. */
function axes(image: { naturalWidth: number; naturalHeight: number }): [number, number] {
  return [image.naturalWidth, image.naturalHeight];
}
