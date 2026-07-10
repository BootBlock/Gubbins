import { describe, it, expect } from 'vitest';
import {
  computeTilt,
  computeShouldTilt,
  DEFAULT_TILT_CONFIG,
  REST_TILT_VARS,
  type TiltConfig,
} from './pointer-tilt';

/** A 200×100 card with tidy magnitudes so the expected values are exact. */
const CONFIG: TiltConfig = { maxTiltDeg: 6, parallaxPx: 10 };
const W = 200;
const H = 100;

describe('computeTilt — geometry (visual-flair F7)', () => {
  it('is perfectly flat at the exact centre (glare centred, no tilt/parallax)', () => {
    expect(computeTilt(W / 2, H / 2, W, H, CONFIG)).toEqual({
      rx: 0,
      ry: 0,
      px: 0,
      py: 0,
      gx: 50,
      gy: 50,
    });
  });

  it('leans toward the cursor: the top-left corner tips that corner toward the viewer', () => {
    // Pointer at the very top-left → normalised (-1, -1).
    const v = computeTilt(0, 0, W, H, CONFIG);
    // rotateX = -ny*max = -(-1)*6 = +6 (top edge toward viewer); rotateY = nx*max = -6.
    expect(v.rx).toBe(6);
    expect(v.ry).toBe(-6);
    // Hero drifts opposite the pointer (counter-parallax): pointer top-left → hero down-right.
    expect(v.px).toBe(10);
    expect(v.py).toBe(10);
    // Glare sits directly under the pointer.
    expect(v.gx).toBe(0);
    expect(v.gy).toBe(0);
  });

  it('mirrors for the opposite (bottom-right) corner', () => {
    const v = computeTilt(W, H, W, H, CONFIG);
    expect(v.rx).toBe(-6);
    expect(v.ry).toBe(6);
    expect(v.px).toBe(-10);
    expect(v.py).toBe(-10);
    expect(v.gx).toBe(100);
    expect(v.gy).toBe(100);
  });

  it('clamps a pointer that has drifted outside the box (never over-tilts)', () => {
    // A pointer read a few px beyond the right/bottom edge must not exceed the peak magnitudes.
    const v = computeTilt(W + 40, H + 40, W, H, CONFIG);
    expect(v.rx).toBe(-CONFIG.maxTiltDeg);
    expect(v.ry).toBe(CONFIG.maxTiltDeg);
    expect(v.px).toBe(-CONFIG.parallaxPx);
    expect(v.py).toBe(-CONFIG.parallaxPx);
    // Glare percentage is likewise clamped to the [0, 100] box.
    expect(v.gx).toBe(100);
    expect(v.gy).toBe(100);
  });

  it('scales linearly between centre and edge', () => {
    // Pointer a quarter of the way across (nx = -0.5) → half the peak tilt.
    const v = computeTilt(W * 0.25, H / 2, W, H, CONFIG);
    expect(v.ry).toBe(-3);
    expect(v.rx).toBe(0);
    expect(v.gx).toBe(25);
  });

  it('returns the flat rest state for a zero-size box (unmeasured / happy-dom) — never NaN', () => {
    expect(computeTilt(10, 10, 0, 0, CONFIG)).toBe(REST_TILT_VARS);
    expect(computeTilt(10, 10, W, 0, CONFIG)).toBe(REST_TILT_VARS);
    // Sanity: the rest state carries no NaNs.
    for (const n of Object.values(REST_TILT_VARS)) expect(Number.isNaN(n)).toBe(false);
  });

  it('defaults to the shared restrained config', () => {
    const v = computeTilt(0, 0, W, H);
    expect(v.rx).toBe(DEFAULT_TILT_CONFIG.maxTiltDeg);
    expect(v.px).toBe(DEFAULT_TILT_CONFIG.parallaxPx);
  });
});

describe('computeShouldTilt — motion gate (mirrors the F6 seam)', () => {
  it('permits tilt when motion is allowed', () => {
    expect(computeShouldTilt(false)).toBe(true);
  });

  it('suppresses tilt under reduced motion', () => {
    expect(computeShouldTilt(true)).toBe(false);
  });
});
