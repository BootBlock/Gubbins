import { describe, expect, it } from 'vitest';
import { ringGeometry } from './inventory-ui';

/**
 * Pure stroke-dash maths for the ring gauge (visual-flair F8). happy-dom has no real SVG
 * geometry, so the offset relationship the draw-on relies on is verified here rather than in a
 * render test: the sweep animates `stroke-dashoffset` from `circumference` (empty) to `offset`.
 */
describe('ringGeometry', () => {
  const SIZE = 40;
  const STROKE = 4;
  const CIRC = 2 * Math.PI * ((SIZE - STROKE) / 2);

  it('insets the radius by half the stroke and derives the circumference', () => {
    const { radius, circumference } = ringGeometry(50, SIZE, STROKE);
    expect(radius).toBe((SIZE - STROKE) / 2);
    expect(circumference).toBeCloseTo(CIRC, 6);
  });

  it('is fully undrawn (offset === circumference) at 0%', () => {
    const { circumference, offset } = ringGeometry(0, SIZE, STROKE);
    expect(offset).toBeCloseTo(circumference, 6);
  });

  it('is fully drawn (offset 0) at 100%', () => {
    expect(ringGeometry(100, SIZE, STROKE).offset).toBeCloseTo(0, 6);
  });

  it('draws half the ring at 50%', () => {
    const { circumference, offset } = ringGeometry(50, SIZE, STROKE);
    expect(offset).toBeCloseTo(circumference / 2, 6);
  });

  it('clamps out-of-range percentages so the dash never goes negative or over-long', () => {
    // A stale/over-100 value stays fully drawn; a negative value stays fully empty. The returned
    // `pct` is clamped to the same bounds so the colour tone never keys off an out-of-range value.
    const over = ringGeometry(140, SIZE, STROKE);
    expect(over.offset).toBeCloseTo(0, 6);
    expect(over.pct).toBe(100);
    const empty = ringGeometry(-20, SIZE, STROKE);
    expect(empty.offset).toBeCloseTo(empty.circumference, 6);
    expect(empty.pct).toBe(0);
  });
});
