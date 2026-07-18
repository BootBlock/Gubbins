import { describe, it, expect } from 'vitest';
import {
  boundsOf,
  circleRadii,
  clampGeometry,
  containBox,
  displayToNormalised,
  normalisedToDisplay,
  parseGeometry,
  serialiseGeometry,
  type DisplayBox,
  type RegionGeometry,
} from './geometry';

/** A 16:9 landscape photo and a 3:4 portrait one — the two orientations every rule must hold for. */
const WIDE = { naturalWidth: 1600, naturalHeight: 900 };
const TALL = { naturalWidth: 900, naturalHeight: 1600 };

describe('containBox — the object-contain letterbox transform (issue #81)', () => {
  it('pillarboxes a wide photo in a tall box (bars left and right)', () => {
    const content = containBox(1600, 900, 400, 800)!;
    expect(content).not.toBeNull();
    // Width-limited: the photo fills the box width and is centred vertically.
    expect(content.width).toBeCloseTo(400);
    expect(content.height).toBeCloseTo(225);
    expect(content.left).toBeCloseTo(0);
    expect(content.top).toBeCloseTo((800 - 225) / 2);
  });

  it('letterboxes a tall photo in a wide box (bars top and bottom)', () => {
    const content = containBox(900, 1600, 800, 400)!;
    expect(content.height).toBeCloseTo(400);
    expect(content.width).toBeCloseTo(225);
    expect(content.top).toBeCloseTo(0);
    expect(content.left).toBeCloseTo((800 - 225) / 2);
  });

  it('shows the whole photo — never crops (the inverse of the scanner object-cover ROI)', () => {
    // object-cover would have scaled to 800/900 here and overflowed the width; contain must not.
    const content = containBox(1600, 900, 800, 800)!;
    expect(content.width).toBeLessThanOrEqual(800);
    expect(content.height).toBeLessThanOrEqual(800);
  });

  it('fills exactly when the aspect ratios match (no bars)', () => {
    const content = containBox(1600, 900, 800, 450)!;
    expect(content).toEqual({ left: 0, top: 0, width: 800, height: 450 });
  });

  it('preserves the photo aspect ratio in both orientations', () => {
    for (const [nw, nh] of [
      [1600, 900],
      [900, 1600],
      [1000, 1000],
    ] as const) {
      const content = containBox(nw, nh, 640, 480)!;
      expect(content.width / content.height).toBeCloseTo(nw / nh, 6);
    }
  });

  it('returns null for unlaid-out, unsized or non-finite input (headless-safe)', () => {
    expect(containBox(1600, 900, 0, 0)).toBeNull(); // jsdom: an unlaid-out box reports 0
    expect(containBox(0, 0, 400, 300)).toBeNull(); // image not loaded yet
    expect(containBox(-10, 900, 400, 300)).toBeNull();
    expect(containBox(Number.NaN, 900, 400, 300)).toBeNull();
    expect(containBox(1600, 900, 400, Number.POSITIVE_INFINITY)).toBeNull();
    expect(containBox(undefined as unknown as number, 900, 400, 300)).toBeNull();
  });
});

describe('normalisedToDisplay / displayToNormalised', () => {
  const content = containBox(1600, 900, 400, 800)!; // pillarboxed

  it('maps the corners and centre of the image onto the content box', () => {
    expect(normalisedToDisplay({ x: 0, y: 0 }, content)).toEqual({
      x: content.left,
      y: content.top,
    });
    expect(normalisedToDisplay({ x: 1, y: 1 }, content)).toEqual({
      x: content.left + content.width,
      y: content.top + content.height,
    });
    const centre = normalisedToDisplay({ x: 0.5, y: 0.5 }, content);
    expect(centre.x).toBeCloseTo(200); // horizontally centred in the 400px box
    expect(centre.y).toBeCloseTo(400);
  });

  it('round-trips exactly, in both orientations and on the letterbox bars', () => {
    const boxes: DisplayBox[] = [
      containBox(1600, 900, 400, 800)!,
      containBox(900, 1600, 800, 400)!,
      containBox(1000, 1000, 500, 500)!,
    ];
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.37, y: 0.82 },
      { x: -0.2, y: 1.4 }, // dragged onto the bars: out of range, but must still invert
    ];
    for (const box of boxes) {
      for (const point of points) {
        const back = displayToNormalised(normalisedToDisplay(point, box), box);
        expect(back.x).toBeCloseTo(point.x, 10);
        expect(back.y).toBeCloseTo(point.y, 10);
      }
    }
  });

  it('does not clamp — a point on the letterbox bar reports outside 0-1', () => {
    const tall = containBox(900, 1600, 800, 400)!;
    const onTheBar = displayToNormalised({ x: 0, y: 200 }, tall);
    expect(onTheBar.x).toBeLessThan(0);
  });

  it('maps everything to 0 for a degenerate content box rather than dividing by zero', () => {
    const empty: DisplayBox = { left: 0, top: 0, width: 0, height: 0 };
    expect(displayToNormalised({ x: 50, y: 50 }, empty)).toEqual({ x: 0, y: 0 });
  });
});

describe('circleRadii — the aspect correction (the subtle one)', () => {
  it('leaves rx as the stored radius and derives ry from the aspect ratio', () => {
    expect(circleRadii(0.2, 1600, 900)).toEqual({ rx: 0.2, ry: 0.2 * (1600 / 900) });
  });

  it('is the identity on a square photo', () => {
    expect(circleRadii(0.25, 1000, 1000)).toEqual({ rx: 0.25, ry: 0.25 });
  });

  it('renders as a true circle in CSS pixels on a WIDE photo', () => {
    // The whole point of the correction: equal pixel radii once mapped through the content box.
    const content = containBox(WIDE.naturalWidth, WIDE.naturalHeight, 800, 800)!;
    const { rx, ry } = circleRadii(0.2, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(rx * content.width).toBeCloseTo(ry * content.height, 6);
  });

  it('renders as a true circle in CSS pixels on a TALL photo', () => {
    const content = containBox(TALL.naturalWidth, TALL.naturalHeight, 800, 800)!;
    const { rx, ry } = circleRadii(0.2, TALL.naturalWidth, TALL.naturalHeight);
    expect(rx * content.width).toBeCloseTo(ry * content.height, 6);
  });

  it('stays circular at every display size (the radii are size-independent)', () => {
    const { rx, ry } = circleRadii(0.15, WIDE.naturalWidth, WIDE.naturalHeight);
    for (const [bw, bh] of [
      [320, 240],
      [1920, 1080],
      [500, 1200],
    ] as const) {
      const content = containBox(WIDE.naturalWidth, WIDE.naturalHeight, bw, bh)!;
      expect(rx * content.width).toBeCloseTo(ry * content.height, 6);
    }
  });

  it('would be an ellipse without the correction (guards against a naive rx = ry = r)', () => {
    const content = containBox(WIDE.naturalWidth, WIDE.naturalHeight, 800, 800)!;
    const naive = 0.2;
    expect(naive * content.width).not.toBeCloseTo(naive * content.height, 3);
  });

  it('falls back to a square correction for unusable dimensions', () => {
    expect(circleRadii(0.3, 0, 0)).toEqual({ rx: 0.3, ry: 0.3 });
    expect(circleRadii(0.3, Number.NaN, 900)).toEqual({ rx: 0.3, ry: 0.3 });
    expect(circleRadii(Number.NaN, 1600, 900)).toEqual({ rx: 0, ry: 0 });
  });
});

describe('boundsOf', () => {
  it('returns a rectangle unchanged', () => {
    const rect: RegionGeometry = { shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(boundsOf(rect)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it('uses the aspect-corrected radii for a circle', () => {
    const circle: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.2 };
    const bounds = boundsOf(circle, WIDE.naturalWidth, WIDE.naturalHeight);
    const { rx, ry } = circleRadii(0.2, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(bounds).toEqual({ x: 0.5 - rx, y: 0.5 - ry, w: rx * 2, h: ry * 2 });
    // On a wide photo the circle spans more of the height than the width, in normalised terms.
    expect(bounds.h).toBeGreaterThan(bounds.w);
  });

  it('defaults to a square image when no dimensions are given', () => {
    const circle: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.2 };
    expect(boundsOf(circle)).toEqual({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
  });

  it('spans the extremes of a polygon, including a concave one', () => {
    const poly: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.5 }, // the notch
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
    };
    expect(boundsOf(poly)).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  });

  it('reports the true extent of an overhanging shape rather than clamping it', () => {
    const rect: RegionGeometry = { shape: 'rect', x: -0.2, y: 0.9, w: 0.5, h: 0.4 };
    expect(boundsOf(rect)).toEqual({ x: -0.2, y: 0.9, w: 0.5, h: 0.4 });
  });
});

describe('clampGeometry — translate where it fits, resize only where it must', () => {
  it('slides an overhanging rectangle back inside without changing its size', () => {
    const clamped = clampGeometry({ shape: 'rect', x: -0.1, y: 0.85, w: 0.3, h: 0.3 });
    expect(clamped).toEqual({ shape: 'rect', x: 0, y: 0.7, w: 0.3, h: 0.3 });
  });

  it('leaves a rectangle already inside untouched', () => {
    const rect: RegionGeometry = { shape: 'rect', x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
    expect(clampGeometry(rect)).toEqual(rect);
  });

  it('caps an oversized rectangle at the image and parks it at the origin', () => {
    expect(clampGeometry({ shape: 'rect', x: -0.5, y: -0.5, w: 2, h: 3 })).toEqual({
      shape: 'rect',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it('moves an overhanging circle rather than shrinking it', () => {
    const clamped = clampGeometry({ shape: 'circle', cx: 0.05, cy: 0.5, r: 0.2 }, 1000, 1000);
    expect(clamped).toEqual({ shape: 'circle', cx: 0.2, cy: 0.5, r: 0.2 });
  });

  it('shrinks a circle only when it cannot fit, and keeps it circular on a wide photo', () => {
    // A radius of 0.4 of the width is 0.711 of the height on 16:9 — it cannot fit vertically.
    const clamped = clampGeometry(
      { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.4 },
      WIDE.naturalWidth,
      WIDE.naturalHeight,
    );
    expect(clamped.shape).toBe('circle');
    const bounds = boundsOf(clamped, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(bounds.x).toBeGreaterThanOrEqual(-1e-12);
    expect(bounds.y).toBeGreaterThanOrEqual(-1e-12);
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(1 + 1e-12);
    // Still a circle: equal pixel radii through the content box.
    const content = containBox(WIDE.naturalWidth, WIDE.naturalHeight, 800, 800)!;
    const { rx, ry } = circleRadii((clamped as { r: number }).r, WIDE.naturalWidth, WIDE.naturalHeight);
    expect(rx * content.width).toBeCloseTo(ry * content.height, 6);
  });

  it('translates a polygon that fits, preserving its shape exactly', () => {
    const poly: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: -0.1, y: 0.2 },
        { x: 0.2, y: 0.2 },
        { x: 0.05, y: 0.6 },
      ],
    };
    const clamped = clampGeometry(poly) as { points: { x: number; y: number }[] };
    // Slid right by exactly the overhang (0.1); the y coordinates already fitted.
    const expected = [
      { x: 0, y: 0.2 },
      { x: 0.3, y: 0.2 },
      { x: 0.15, y: 0.6 },
    ];
    clamped.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i]!.x, 12);
      expect(p.y).toBeCloseTo(expected[i]!.y, 12);
    });
    // Shape preserved: every edge vector is unchanged.
    expect(clamped.points[1]!.x - clamped.points[0]!.x).toBeCloseTo(0.3, 12);
  });

  it('clamps each vertex of a polygon too large to translate into range', () => {
    const poly: RegionGeometry = {
      shape: 'polygon',
      points: [
        { x: -0.5, y: -0.5 },
        { x: 1.8, y: 0.5 },
        { x: 0.5, y: 1.9 },
      ],
    };
    const clamped = clampGeometry(poly) as { points: { x: number; y: number }[] };
    for (const p of clamped.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('turns non-finite coordinates into a valid degenerate shape rather than propagating NaN', () => {
    const clamped = clampGeometry({
      shape: 'rect',
      x: Number.NaN,
      y: 0.5,
      w: Number.POSITIVE_INFINITY,
      h: 0.2,
    });
    expect(Object.values(clamped).every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
  });
});

describe('parseGeometry / serialiseGeometry — the JSON TEXT column', () => {
  const rect: RegionGeometry = { shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.15 };
  const circle: RegionGeometry = { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.2 };
  const polygon: RegionGeometry = {
    shape: 'polygon',
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.6, y: 0.2 },
      { x: 0.3, y: 0.7 },
    ],
  };

  it('round-trips every shape', () => {
    for (const geometry of [rect, circle, polygon]) {
      expect(parseGeometry(serialiseGeometry(geometry), geometry.shape)).toEqual(geometry);
    }
  });

  it('omits the shape discriminator from the stored JSON (it lives in its own column)', () => {
    expect(JSON.parse(serialiseGeometry(rect))).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.15 });
    expect(JSON.parse(serialiseGeometry(circle))).toEqual({ cx: 0.5, cy: 0.5, r: 0.2 });
    expect(serialiseGeometry(polygon)).not.toContain('shape');
  });

  it('matches the JSON shapes the schema documents', () => {
    expect(parseGeometry('{"x":0.1,"y":0.2,"w":0.3,"h":0.15}', 'rect')).toEqual(rect);
    expect(parseGeometry('{"cx":0.5,"cy":0.5,"r":0.2}', 'circle')).toEqual(circle);
  });

  it('rejects malformed JSON without throwing', () => {
    expect(parseGeometry('', 'rect')).toBeNull();
    expect(parseGeometry('not json', 'rect')).toBeNull();
    expect(parseGeometry('{"x":0.1,', 'rect')).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(parseGeometry('null', 'rect')).toBeNull();
    expect(parseGeometry('42', 'circle')).toBeNull();
    expect(parseGeometry('"0.5"', 'rect')).toBeNull();
    expect(parseGeometry('[]', 'polygon')).toBeNull();
  });

  it('rejects geometry stored for the wrong shape', () => {
    expect(parseGeometry(serialiseGeometry(circle), 'rect')).toBeNull();
    expect(parseGeometry(serialiseGeometry(rect), 'circle')).toBeNull();
    expect(parseGeometry(serialiseGeometry(rect), 'polygon')).toBeNull();
  });

  it('rejects missing, non-numeric or non-finite fields', () => {
    expect(parseGeometry('{"x":0.1,"y":0.2,"w":0.3}', 'rect')).toBeNull(); // no h
    expect(parseGeometry('{"x":"0.1","y":0.2,"w":0.3,"h":0.4}', 'rect')).toBeNull();
    expect(parseGeometry('{"x":null,"y":0.2,"w":0.3,"h":0.4}', 'rect')).toBeNull();
    // JSON cannot carry NaN/Infinity literally; a corrupt writer emits null or a string.
    expect(parseGeometry('{"cx":0.5,"cy":0.5,"r":"NaN"}', 'circle')).toBeNull();
  });

  it('rejects degenerate sizes', () => {
    expect(parseGeometry('{"x":0.1,"y":0.2,"w":0,"h":0.4}', 'rect')).toBeNull();
    expect(parseGeometry('{"x":0.1,"y":0.2,"w":-0.3,"h":0.4}', 'rect')).toBeNull();
    expect(parseGeometry('{"cx":0.5,"cy":0.5,"r":0}', 'circle')).toBeNull();
    expect(parseGeometry('{"cx":0.5,"cy":0.5,"r":-0.2}', 'circle')).toBeNull();
  });

  it('rejects polygons with too few or malformed points', () => {
    expect(parseGeometry('{"points":[]}', 'polygon')).toBeNull();
    expect(parseGeometry('{"points":[{"x":0,"y":0},{"x":1,"y":1}]}', 'polygon')).toBeNull();
    expect(parseGeometry('{"points":"nope"}', 'polygon')).toBeNull();
    expect(parseGeometry('{}', 'polygon')).toBeNull();
    expect(parseGeometry('{"points":[{"x":0,"y":0},{"x":1,"y":1},null]}', 'polygon')).toBeNull();
    expect(parseGeometry('{"points":[{"x":0,"y":0},{"x":1,"y":1},{"x":0.5}]}', 'polygon')).toBeNull();
  });

  it('rejects an absurd number of polygon points (a corrupt or hostile payload)', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ x: i / 600, y: 0.5 }));
    expect(parseGeometry(JSON.stringify({ points: many }), 'polygon')).toBeNull();
  });

  it('rejects an unknown shape', () => {
    expect(parseGeometry('{"x":0,"y":0,"w":1,"h":1}', 'blob' as 'rect')).toBeNull();
  });

  it('accepts out-of-range but finite coordinates (clamping is a separate decision)', () => {
    // Parsing must not silently discard a region that merely overhangs; clampGeometry owns that.
    expect(parseGeometry('{"x":-0.2,"y":0.5,"w":0.4,"h":0.4}', 'rect')).not.toBeNull();
  });
});
