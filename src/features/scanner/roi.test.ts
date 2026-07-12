import { describe, it, expect } from 'vitest';
import { computeCoverRoi, type CoverRoiSource } from './roi';

/** A frame + displayed-box shape for {@link computeCoverRoi}. */
function frame(
  videoWidth: number,
  videoHeight: number,
  clientWidth: number,
  clientHeight: number,
): CoverRoiSource {
  return { videoWidth, videoHeight, clientWidth, clientHeight };
}

describe('computeCoverRoi — visible object-cover region (issue #59)', () => {
  it('crops the invisible side margins of a landscape frame on a portrait screen', () => {
    // A 1080p landscape camera shown full-screen on a tall phone: the sides are off-screen.
    const roi = computeCoverRoi(frame(1920, 1080, 390, 844));
    expect(roi).not.toBeNull();
    // Full height is visible; the width is a narrow central slice, centred horizontally.
    expect(roi!.sh).toBe(1080);
    expect(roi!.sy).toBe(0);
    expect(roi!.sw).toBeLessThan(1920);
    expect(roi!.sx).toBe(Math.floor((1920 - roi!.sw) / 2));
  });

  it('crops the top/bottom of a portrait frame on a landscape screen', () => {
    const roi = computeCoverRoi(frame(1080, 1920, 800, 400));
    expect(roi).not.toBeNull();
    expect(roi!.sw).toBe(1080); // full width visible
    expect(roi!.sh).toBeLessThan(1920); // a central horizontal band
    expect(roi!.sx).toBe(0);
    expect(roi!.sy).toBe(Math.floor((1920 - roi!.sh) / 2));
  });

  it('returns null when the whole frame is already visible (matched aspect)', () => {
    expect(computeCoverRoi(frame(1000, 1000, 500, 500))).toBeNull();
  });

  it('returns null for an unlaid-out or unsized element (no crop, headless-safe)', () => {
    expect(computeCoverRoi(frame(640, 480, 0, 0))).toBeNull();
    expect(computeCoverRoi(frame(0, 0, 390, 844))).toBeNull();
    // A bare fake with missing client dimensions must not yield a NaN rectangle.
    expect(computeCoverRoi({ videoWidth: 640, videoHeight: 480 } as unknown as CoverRoiSource)).toBeNull();
  });

  it('keeps the crop rectangle within the frame bounds', () => {
    const roi = computeCoverRoi(frame(1920, 1080, 411, 914))!;
    expect(roi.sx).toBeGreaterThanOrEqual(0);
    expect(roi.sy).toBeGreaterThanOrEqual(0);
    expect(roi.sx + roi.sw).toBeLessThanOrEqual(1920);
    expect(roi.sy + roi.sh).toBeLessThanOrEqual(1080);
  });
});
