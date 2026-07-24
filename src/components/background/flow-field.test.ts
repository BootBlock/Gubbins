/**
 * Unit tests for the pure wind maths. These are the testable core of the weather layer (the canvas
 * engine needs a real 2D context, which the test DOM lacks), so they pin the invariants the visual
 * effect relies on: bounded output, smoothness (no per-frame jumps), and a genuinely swirling —
 * divergence-free — turbulence field.
 */
import { describe, it, expect } from 'vitest';
import {
  gust,
  flurry,
  curlField,
  gustPulse,
  blizzard,
  blizzardWind,
  squall,
  diamondDust,
  graupelShower,
  warmSnow,
  deadAir,
  lightningFlash,
  smooth01,
} from './flow-field';

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

describe('smooth01', () => {
  it('clamps outside [0, 1] and eases monotonically between', () => {
    expect(smooth01(-2)).toBe(0);
    expect(smooth01(0)).toBe(0);
    expect(smooth01(1)).toBe(1);
    expect(smooth01(3)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const v = smooth01(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('blizzard', () => {
  it('stays within [0, 1] across an hour', () => {
    for (const v of sample(blizzard, 14400, 0.25)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is calm for the whole first epoch — the layer never opens mid-storm', () => {
    for (let t = 0; t < 130; t += 0.5) expect(blizzard(t)).toBe(0);
  });

  it('is mostly calm but occasionally reaches a full storm', () => {
    const xs = sample(blizzard, 14400, 0.25); // one hour
    const calm = xs.filter((v) => v < 0.05).length / xs.length;
    expect(calm).toBeGreaterThan(0.7); // storms are occasional, not the norm
    expect(Math.max(...xs)).toBeGreaterThan(0.95); // …but they genuinely arrive
  });

  it('is smooth — no per-frame jumps even through a storm front', () => {
    let prev = blizzard(0);
    for (let i = 1; i < 40000; i++) {
      const v = blizzard(i * 0.016); // ~60fps across the first storms
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
  });
});

describe('blizzardWind', () => {
  it('matches the storm envelope in magnitude and holds one direction per storm', () => {
    let dir = 0;
    let prevEnv = 0;
    for (let t = 0; t < 3600; t += 0.25) {
      const env = blizzard(t);
      const wind = blizzardWind(t);
      expect(Math.abs(wind)).toBeCloseTo(env, 10);
      if (env > 0.05) {
        const sign = Math.sign(wind);
        // A fresh storm may pick either way, but the direction never flips mid-storm.
        if (prevEnv > 0.05 && dir !== 0) expect(sign).toBe(dir);
        dir = sign;
      }
      prevEnv = env;
    }
  });
});

describe('gustPulse', () => {
  it('stays within [-1, 1]', () => {
    for (const v of sample(gustPulse, 24000, 0.05)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is mostly quiet with occasional decisive shoves', () => {
    const xs = sample(gustPulse, 24000, 0.05); // 20 minutes
    const quiet = xs.filter((v) => Math.abs(v) < 0.02).length / xs.length;
    expect(quiet).toBeGreaterThan(0.5); // pulses are events, not a constant hum
    expect(Math.max(...xs.map(Math.abs))).toBeGreaterThan(0.6); // …and they genuinely shove
  });

  it('dips into a lull below zero after a pulse (the die-down overshoot)', () => {
    // Find a positive-going pulse, then check the signed value crosses to the other side of
    // zero within its event window — the trailing lull.
    let found = false;
    for (let t = 0; t < 3600 && !found; t += 0.05) {
      const v = gustPulse(t);
      if (Math.abs(v) < 0.3) continue;
      const sign = Math.sign(v);
      for (let u = t; u < t + 20; u += 0.05) {
        if (Math.sign(gustPulse(u)) === -sign && Math.abs(gustPulse(u)) > 0.01) {
          found = true;
          break;
        }
      }
      break;
    }
    expect(found).toBe(true);
  });

  it('is smooth — small time steps produce small changes', () => {
    let prev = gustPulse(0);
    for (let i = 1; i < 40000; i++) {
      const v = gustPulse(i * 0.016);
      expect(Math.abs(v - prev)).toBeLessThan(0.1);
      prev = v;
    }
  });
});

describe('event spells (squall / diamond dust / graupel / warm snow / dead air)', () => {
  const spells: ReadonlyArray<[string, (t: number) => number, number]> = [
    ['squall', squall, 90],
    ['diamondDust', diamondDust, 110],
    ['graupelShower', graupelShower, 100],
    ['warmSnow', warmSnow, 70],
    ['deadAir', deadAir, 85],
  ];

  it.each(spells)('%s stays within [0, 1] across an hour', (_name, fn) => {
    for (const v of sample(fn, 14400, 0.25)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it.each(spells)('%s is quiet for its whole first epoch', (_name, fn, epoch) => {
    for (let t = 0; t < epoch; t += 0.5) expect(fn(t)).toBe(0);
  });

  it.each(spells)('%s is mostly quiet but genuinely occurs', (_name, fn) => {
    const xs = sample(fn, 14400, 0.25); // one hour
    const quiet = xs.filter((v) => v < 0.05).length / xs.length;
    expect(quiet).toBeGreaterThan(0.5); // events, not a constant state
    expect(Math.max(...xs)).toBeGreaterThan(0.95); // …that genuinely reach full strength
  });

  it.each(spells)('%s is smooth — no per-frame jumps', (_name, fn) => {
    let prev = fn(0);
    for (let i = 1; i < 40000; i++) {
      const v = fn(i * 0.016);
      expect(Math.abs(v - prev)).toBeLessThan(0.06);
      prev = v;
    }
  });
});

describe('lightningFlash', () => {
  it('stays within [0, 1] and is zero almost always', () => {
    const xs = sample((t) => lightningFlash(t), 24000, 0.05); // 20 minutes
    for (const v of xs) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const zero = xs.filter((v) => v < 0.01).length / xs.length;
    expect(zero).toBeGreaterThan(0.9);
  });

  it('genuinely flashes, and flickers through more than one stroke per event', () => {
    // Find a flash event, then confirm the intensity dips and re-rises inside its window —
    // the multi-stroke flicker that makes lightning read as lightning.
    let flickered = false;
    for (let t = 0; t < 600 && !flickered; t += 0.01) {
      if (lightningFlash(t) < 0.9) continue;
      let dipped = false;
      for (let u = t; u < t + 0.6; u += 0.01) {
        const v = lightningFlash(u);
        if (!dipped && v < 0.2) dipped = true;
        else if (dipped && v > 0.4) {
          flickered = true;
          break;
        }
      }
      break;
    }
    expect(flickered).toBe(true);
  });

  it('flashes far more often on the dense (lab) cadence', () => {
    const count = (dense: boolean): number => {
      let events = 0;
      let active = false;
      for (let t = 0; t < 600; t += 0.02) {
        const on = lightningFlash(t, dense) > 0.1;
        if (on && !active) events++;
        active = on;
      }
      return events;
    };
    expect(count(true)).toBeGreaterThan(count(false) * 2);
  });
});
