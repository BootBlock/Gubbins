import { describe, it, expect } from 'vitest';
import { rgbaToLuminance } from './luminance';

/**
 * Pure RGBA→grayscale conversion feeding the off-thread zxing decoder (spec §6.6).
 * The decode worker hands these luminance bytes straight to `RGBLuminanceSource`, so
 * the weighting must match zxing's own ARGB→luma reduction `(r + 2g + b) >> 2`.
 */
function rgba(...pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    data.set([r, g, b, a], i * 4);
  });
  return data;
}

describe('rgbaToLuminance (spec §6.6 worker decode)', () => {
  it('produces one luminance byte per pixel (drops the alpha channel)', () => {
    const out = rgbaToLuminance(rgba([0, 0, 0, 255], [255, 255, 255, 255]), 2, 1);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0); // black
    expect(out[1]).toBe(255); // white
  });

  it('weights green twice as heavily as red/blue, matching zxing (r + 2g + b) >> 2', () => {
    // Pure green 255 → (0 + 2*255 + 0) >> 2 = 127; pure red → (255 + 0 + 0) >> 2 = 63.
    const out = rgbaToLuminance(rgba([0, 255, 0, 255], [255, 0, 0, 255]), 2, 1);
    expect(out[0]).toBe(127);
    expect(out[1]).toBe(63);
  });

  it('ignores the alpha byte entirely (a transparent white still reads as white)', () => {
    const opaque = rgbaToLuminance(rgba([200, 200, 200, 255]), 1, 1);
    const transparent = rgbaToLuminance(rgba([200, 200, 200, 0]), 1, 1);
    expect(transparent[0]).toBe(opaque[0]);
  });

  it('covers the whole frame for a multi-pixel image', () => {
    const out = rgbaToLuminance(
      rgba([10, 10, 10, 255], [20, 20, 20, 255], [30, 30, 30, 255], [40, 40, 40, 255]),
      2,
      2,
    );
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
  });
});
