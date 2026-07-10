/**
 * Unit tests for the pure wind maths. These are the testable core of the weather layer (the canvas
 * engine needs a real 2D context, which the test DOM lacks), so they pin the invariants the visual
 * effect relies on: bounded output, smoothness (no per-frame jumps), and a genuinely swirling —
 * divergence-free — turbulence field.
 */
import { describe, it, expect } from 'vitest';
import { gust, flurry, curlField } from './flow-field';

/** Sample a function across a long time span. */
function sample(fn: (t: number) => number, count = 4000, dt = 0.05): number[] {
  return Array.from({ length: count }, (_, i) => fn(i * dt));
}

describe('gust', () => {
  it('stays within [-1, 1] across a long run', () => {
    for (const v of sample((t) => gust(t))) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is smooth — small time steps produce small changes (no jumps)', () => {
    let prev = gust(0);
    for (let i = 1; i < 2000; i++) {
      const v = gust(i * 0.016); // ~60fps
      expect(Math.abs(v - prev)).toBeLessThan(0.1);
      prev = v;
    }
  });

  it('actually moves — it is not a constant', () => {
    const xs = sample((t) => gust(t));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1); // swings both ways
  });

  it('decorrelates channels by seed', () => {
    const a = gust(3.2, 0);
    const b = gust(3.2, 5);
    expect(a).not.toBeCloseTo(b, 5);
  });
});

describe('flurry', () => {
  it('stays within [0, 1]', () => {
    for (const v of sample((t) => flurry(t))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('has both calm and surging passages', () => {
    const xs = sample((t) => flurry(t));
    expect(Math.min(...xs)).toBeLessThan(0.3); // genuinely calms down
    expect(Math.max(...xs)).toBeGreaterThan(0.7); // genuinely surges
  });
});

describe('curlField', () => {
  it('returns bounded, finite components', () => {
    for (let i = 0; i < 500; i++) {
      const v = curlField(i * 13.7, i * 7.3, i * 0.05);
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
      expect(Math.abs(v.x)).toBeLessThan(3);
      expect(Math.abs(v.y)).toBeLessThan(3);
    }
  });

  it('is (approximately) divergence-free — a swirling field, not a source/sink', () => {
    // ∂vx/∂x + ∂vy/∂y ≈ 0 everywhere for the curl of a scalar potential.
    const t = 4.2;
    const h = 0.5;
    let worst = 0;
    for (let gx = 0; gx < 6; gx++) {
      for (let gy = 0; gy < 6; gy++) {
        const x = gx * 60 + 15;
        const y = gy * 60 + 15;
        const dvxdx = (curlField(x + h, y, t).x - curlField(x - h, y, t).x) / (2 * h);
        const dvydy = (curlField(x, y + h, t).y - curlField(x, y - h, t).y) / (2 * h);
        worst = Math.max(worst, Math.abs(dvxdx + dvydy));
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('has non-zero curl — it genuinely rotates (contains vortices)', () => {
    // ∂vy/∂x - ∂vx/∂y should be substantial somewhere for a turbulent field.
    const t = 4.2;
    const h = 0.5;
    let maxCurl = 0;
    for (let gx = 0; gx < 8; gx++) {
      for (let gy = 0; gy < 8; gy++) {
        const x = gx * 45 + 10;
        const y = gy * 45 + 10;
        const dvydx = (curlField(x + h, y, t).y - curlField(x - h, y, t).y) / (2 * h);
        const dvxdy = (curlField(x, y + h, t).x - curlField(x, y - h, t).x) / (2 * h);
        maxCurl = Math.max(maxCurl, Math.abs(dvydx - dvxdy));
      }
    }
    expect(maxCurl).toBeGreaterThan(1e-3);
  });
});
