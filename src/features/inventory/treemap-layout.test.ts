import { describe, expect, it } from 'vitest';
import { squarifyTreemap, type TreemapDatum } from './treemap-layout';

interface Group extends TreemapDatum {
  readonly id: string;
  readonly weight: number;
}

const groups = (weights: Record<string, number>): Group[] =>
  Object.entries(weights).map(([id, weight]) => ({ id, weight }));

const totalArea = (rects: readonly { width: number; height: number }[]) =>
  rects.reduce((s, r) => s + r.width * r.height, 0);

describe('squarifyTreemap', () => {
  it('returns no tiles for an empty input or a degenerate container', () => {
    expect(squarifyTreemap([], 100, 100)).toEqual([]);
    expect(squarifyTreemap(groups({ a: 5 }), 0, 100)).toEqual([]);
    expect(squarifyTreemap(groups({ a: 5 }), 100, -1)).toEqual([]);
  });

  it('drops non-positive and non-finite weights', () => {
    const rects = squarifyTreemap(
      [
        { id: 'a', weight: 10 },
        { id: 'b', weight: 0 },
        { id: 'c', weight: -3 },
        { id: 'd', weight: Number.NaN },
        { id: 'e', weight: Number.POSITIVE_INFINITY },
      ],
      100,
      100,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0]!.datum.id).toBe('a');
  });

  it('fills the whole container area (area is conserved)', () => {
    const rects = squarifyTreemap(groups({ a: 6, b: 6, c: 4, d: 3, e: 1 }), 600, 400);
    expect(rects).toHaveLength(5);
    expect(totalArea(rects)).toBeCloseTo(600 * 400, 4);
  });

  it('makes each tile area proportional to its weight', () => {
    const rects = squarifyTreemap(groups({ big: 3, small: 1 }), 200, 100);
    const areaOf = (id: string) => {
      const r = rects.find((rect) => rect.datum.id === id)!;
      return r.width * r.height;
    };
    // 3:1 weights over a 20 000 px² container → 15 000 and 5 000.
    expect(areaOf('big')).toBeCloseTo(15_000, 4);
    expect(areaOf('small')).toBeCloseTo(5_000, 4);
  });

  it('keeps every tile inside the container bounds', () => {
    const rects = squarifyTreemap(groups({ a: 5, b: 4, c: 3, d: 2, e: 2, f: 1 }), 320, 240);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.width).toBeLessThanOrEqual(320 + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(240 + 1e-6);
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it('places a single item as the whole container', () => {
    const [rect, ...rest] = squarifyTreemap(groups({ only: 42 }), 150, 90);
    expect(rest).toHaveLength(0);
    expect(rect).toMatchObject({ x: 0, y: 0, width: 150, height: 90 });
  });

  it('produces reasonably square tiles for equal weights (better than slice-and-dice)', () => {
    // Four equal tiles in a square container should each be ~square (aspect ≈ 1), not thin strips.
    const rects = squarifyTreemap(groups({ a: 1, b: 1, c: 1, d: 1 }), 100, 100);
    for (const r of rects) {
      const aspect = Math.max(r.width / r.height, r.height / r.width);
      expect(aspect).toBeLessThan(1.5);
    }
  });
});
