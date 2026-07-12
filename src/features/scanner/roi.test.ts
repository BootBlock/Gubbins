import { describe, it, expect } from 'vitest';
import { computeCoverRoi, computeRectRoi, elementRoiOf, type CoverRoiSource, type DisplayRect } from './roi';

/** A frame + displayed-box shape for {@link computeCoverRoi}. */
function frame(
  videoWidth: number,
  videoHeight: number,
  clientWidth: number,
  clientHeight: number,
): CoverRoiSource {
  return { videoWidth, videoHeight, clientWidth, clientHeight };
}

/** A centred square of side `size` within `box` — the reticle geometry. */
function centredSquare(box: DisplayRect, size: number): DisplayRect {
  return {
    left: box.left + (box.width - size) / 2,
    top: box.top + (box.height - size) / 2,
    width: size,
    height: size,
  };
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

describe('computeRectRoi — crop to the reticle box (issue #59)', () => {
  const video: DisplayRect = { left: 0, top: 0, width: 1440, height: 900 };

  it('crops a landscape desktop frame to a small centred region around the reticle', () => {
    // The case the cover crop does *not* help: a landscape camera on a landscape desktop, where
    // the cover-visible region is almost the whole frame. Cropping to the reticle shrinks it.
    const roi = computeRectRoi({
      videoWidth: 1920,
      videoHeight: 1080,
      video,
      target: centredSquare(video, 448),
      pad: 0.15,
    })!;
    expect(roi).not.toBeNull();
    // A roughly square central crop, far smaller than the full frame in both axes.
    expect(roi.sw).toBeLessThan(1920 * 0.5);
    expect(roi.sh).toBeLessThan(1080 * 0.9);
    expect(Math.abs(roi.sw - roi.sh)).toBeLessThan(4); // square reticle → square crop
    // Centred within the frame.
    expect(roi.sx).toBeCloseTo((1920 - roi.sw) / 2, -1);
    expect(roi.sy).toBeCloseTo((1080 - roi.sh) / 2, -1);
    // And within bounds.
    expect(roi.sx).toBeGreaterThanOrEqual(0);
    expect(roi.sy).toBeGreaterThanOrEqual(0);
    expect(roi.sx + roi.sw).toBeLessThanOrEqual(1920);
    expect(roi.sy + roi.sh).toBeLessThanOrEqual(1080);
  });

  it('grows the crop with the pad factor (a barcode slightly outside the box still fits)', () => {
    const args = { videoWidth: 1920, videoHeight: 1080, video, target: centredSquare(video, 448) };
    const tight = computeRectRoi({ ...args, pad: 0 })!;
    const padded = computeRectRoi({ ...args, pad: 0.15 })!;
    expect(padded.sw).toBeGreaterThan(tight.sw);
    expect(padded.sh).toBeGreaterThan(tight.sh);
  });

  it('returns null when the target already covers the whole visible frame', () => {
    // A 16:9 frame shown in a 16:9 box (no cover overflow); a target the size of the box maps to
    // the whole frame → no crop.
    const box: DisplayRect = { left: 0, top: 0, width: 1440, height: 810 };
    expect(computeRectRoi({ videoWidth: 1920, videoHeight: 1080, video: box, target: box })).toBeNull();
  });

  it('returns null for a zero-sized target or unsized frame (headless-safe)', () => {
    expect(
      computeRectRoi({
        videoWidth: 1920,
        videoHeight: 1080,
        video,
        target: { left: 100, top: 100, width: 0, height: 0 },
      }),
    ).toBeNull();
    expect(
      computeRectRoi({ videoWidth: 0, videoHeight: 0, video, target: centredSquare(video, 448) }),
    ).toBeNull();
  });

  it('clamps a reticle that overflows the video box to the frame bounds', () => {
    // A reticle taller than the video box (80vmin can exceed the between-chrome video height).
    const roi = computeRectRoi({
      videoWidth: 1920,
      videoHeight: 1080,
      video,
      target: centredSquare(video, 1400),
      pad: 0.15,
    })!;
    expect(roi.sx).toBeGreaterThanOrEqual(0);
    expect(roi.sy).toBeGreaterThanOrEqual(0);
    expect(roi.sx + roi.sw).toBeLessThanOrEqual(1920);
    expect(roi.sy + roi.sh).toBeLessThanOrEqual(1080);
  });
});

describe('elementRoiOf — reticle crop with cover / whole-frame fallback (issue #59)', () => {
  function fakeVideo(rect: DisplayRect | null, vw = 1920, vh = 1080): HTMLVideoElement {
    return {
      videoWidth: vw,
      videoHeight: vh,
      clientWidth: rect?.width ?? 0,
      clientHeight: rect?.height ?? 0,
      getBoundingClientRect: () => rect ?? { left: 0, top: 0, width: 0, height: 0 },
    } as unknown as HTMLVideoElement;
  }
  function fakeEl(rect: DisplayRect): HTMLElement {
    return { getBoundingClientRect: () => rect } as unknown as HTMLElement;
  }

  it('crops to the reticle element when it can be measured', () => {
    const box: DisplayRect = { left: 0, top: 0, width: 1440, height: 900 };
    const roi = elementRoiOf(fakeVideo(box), fakeEl(centredSquare(box, 448)))!;
    expect(roi).not.toBeNull();
    expect(roi.sw).toBeLessThan(1920 * 0.5); // the tightened reticle crop, not the full frame
  });

  it('falls back to the cover-visible region when no reticle element is given', () => {
    // Portrait phone shape, no reticle: same result as computeCoverRoi (full height, cropped sides).
    const video = fakeVideo({ left: 0, top: 0, width: 390, height: 844 });
    expect(elementRoiOf(video, null)).toEqual(computeCoverRoi(video));
  });

  it('falls back to the whole frame (null) when neither reticle nor cover crop applies', () => {
    // Unlaid-out element (0×0), as in headless tests → no reticle crop, no cover crop.
    expect(elementRoiOf(fakeVideo(null), fakeEl({ left: 0, top: 0, width: 0, height: 0 }))).toBeNull();
  });
});
