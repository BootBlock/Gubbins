/**
 * Region-of-interest cropping for the live scanner (issue #59).
 *
 * The scanner `<video>` is displayed with `object-cover`, so a wide (landscape) camera frame
 * shown on a tall (portrait) phone is scaled up to fill the screen and its **sides are cropped
 * off-screen**. The decoder, however, reads the *whole* sensor frame — including those invisible
 * side margins — so a barcode the user has centred in the viewfinder occupies only a small
 * fraction of the analysed image and doesn't read until it fills the screen. That mismatch is a
 * common reason a clear, well-framed barcode "won't scan".
 *
 * {@link computeCoverRoi} returns the source-pixel rectangle that the viewfinder actually shows,
 * so every decode tier can crop to it: the barcode then becomes large relative to the analysed
 * pixels — exactly what a size-thresholded detector needs — and "what's in the viewfinder" is
 * "what's decoded". The maths is pure and unit-tested; the DOM-side cropping (canvas / bitmap)
 * lives with each engine.
 *
 * That cover-crop only removes the margins an `object-cover` video hides, which on a **portrait
 * phone** (tall display, landscape camera) is a lot but on a **landscape desktop** (display and
 * camera share an aspect ratio) is almost nothing — so a barcode centred in the reticle stays
 * small within a near-full-frame analysis and won't read until it fills the screen (issue #59,
 * reopened). {@link computeRectRoi} / {@link elementRoiOf} tighten the crop to the **reticle box**
 * the user is told to aim into, so a framed barcode is large relative to the analysed pixels on
 * *any* viewport shape — the crop that actually helps on desktop — falling back to the cover crop
 * (then the whole frame) whenever the reticle can't be measured.
 */

/** A crop rectangle in a video frame's own source-pixel coordinates. */
export interface FrameRoi {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * A displayed (CSS-pixel) rectangle — the subset of `DOMRect` the reticle crop needs.
 *
 * @internal Exported for unit tests only.
 */
export interface DisplayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How much to grow the reticle box (as a fraction of its size, per side) before cropping to it, so
 * a barcode held a touch larger than the guide — or a wide 1-D code whose quiet zones just overrun
 * it — still falls inside the analysed region rather than being clipped at the edge.
 */
export const RETICLE_ROI_PAD = 0.15;

/** The frame + displayed-box dimensions {@link computeCoverRoi} needs (a subset of `HTMLVideoElement`). */
export interface CoverRoiSource {
  /** Intrinsic frame width in source pixels (`HTMLVideoElement.videoWidth`). */
  readonly videoWidth: number;
  /** Intrinsic frame height in source pixels (`HTMLVideoElement.videoHeight`). */
  readonly videoHeight: number;
  /** Displayed (CSS) box width (`HTMLElement.clientWidth`). */
  readonly clientWidth: number;
  /** Displayed (CSS) box height (`HTMLElement.clientHeight`). */
  readonly clientHeight: number;
}

/**
 * Compute the centred source-pixel rectangle an `object-cover` `<video>` actually shows, or
 * `null` when it can't be computed or would be a no-op — an unlaid-out element (client size 0,
 * as in headless tests), an unsized frame, or a frame already shown in full. Callers treat
 * `null` as "decode the whole frame", preserving the prior behaviour.
 */
export function computeCoverRoi(source: CoverRoiSource): FrameRoi | null {
  const { videoWidth: vw, videoHeight: vh, clientWidth: cw, clientHeight: ch } = source;
  // Reject anything not a positive finite number (an unlaid-out element reports 0; a bare test
  // fake may omit the client dimensions entirely → `undefined`/`NaN`).
  if (![vw, vh, cw, ch].every((n) => Number.isFinite(n) && n > 0)) return null;

  // `object-cover` scales the frame up until it covers the box, cropping the overflow; the
  // visible source region is the box mapped back through that scale.
  const scale = Math.max(cw / vw, ch / vh);
  const sw = Math.min(Math.round(cw / scale), vw);
  const sh = Math.min(Math.round(ch / scale), vh);
  if (sw <= 0 || sh <= 0) return null;
  if (sw >= vw && sh >= vh) return null; // whole frame already visible — nothing to crop

  const sx = Math.max(0, Math.floor((vw - sw) / 2));
  const sy = Math.max(0, Math.floor((vh - sh) / 2));
  return { sx, sy, sw, sh };
}

/**
 * Compute the source-pixel rectangle behind a **target box** (the reticle) displayed over an
 * `object-cover` `<video>`. Both rectangles are in the same CSS-pixel coordinate space (as
 * `getBoundingClientRect` gives). The target is grown by {@link RETICLE_ROI_PAD} per side, clamped
 * to the video box, then mapped back through the cover scale to source pixels. Pure and
 * unit-tested; the DOM reads live in {@link elementRoiOf}.
 *
 * Returns `null` when it can't be computed or would be a no-op — a zero-sized element (unlaid-out,
 * as in headless tests), an unsized frame, or a target that already covers the whole frame — so
 * callers fall back to the cover crop / whole frame exactly as before.
 *
 * @internal Exported for unit tests only.
 */
export function computeRectRoi(args: {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly video: DisplayRect;
  readonly target: DisplayRect;
  /** Grow the target by this fraction of its size per side before cropping (default 0). */
  readonly pad?: number;
}): FrameRoi | null {
  const { videoWidth: vw, videoHeight: vh, video, target } = args;
  const pad = args.pad ?? 0;
  const { width: cw, height: ch } = video;
  if (![vw, vh, cw, ch, target.width, target.height].every((n) => Number.isFinite(n) && n > 0)) {
    return null;
  }

  // `object-cover` scales the frame up by `scale` (source px → CSS px) and centres it in the box,
  // overflowing the shorter axis. Invert that to map a CSS point back to a source pixel.
  const scale = Math.max(cw / vw, ch / vh);
  if (!(scale > 0)) return null;
  const contentLeft = video.left + (cw - vw * scale) / 2;
  const contentTop = video.top + (ch - vh * scale) / 2;

  // Grow the target, then clamp it to the visible video box (the cover content fills it).
  const padX = target.width * pad;
  const padY = target.height * pad;
  const tl = Math.max(target.left - padX, video.left);
  const tr = Math.min(target.left + target.width + padX, video.left + cw);
  const tt = Math.max(target.top - padY, video.top);
  const tb = Math.min(target.top + target.height + padY, video.top + ch);

  const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), max);
  const sx = clamp(Math.round((tl - contentLeft) / scale), vw);
  const ex = clamp(Math.round((tr - contentLeft) / scale), vw);
  const sy = clamp(Math.round((tt - contentTop) / scale), vh);
  const ey = clamp(Math.round((tb - contentTop) / scale), vh);
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return null;
  if (sw >= vw && sh >= vh) return null; // covers the whole frame — nothing to crop
  return { sx, sy, sw, sh };
}

/**
 * The production ROI provider for the decode engines: crop to the **reticle** element when it can
 * be measured (the crop that helps on every viewport shape), else the cover-visible region, else
 * the whole frame. Reads the live geometry each call so it tracks resizes and orientation changes.
 */
export function elementRoiOf(video: HTMLVideoElement, target: HTMLElement | null): FrameRoi | null {
  if (target && typeof target.getBoundingClientRect === 'function') {
    const roi = computeRectRoi({
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      video: video.getBoundingClientRect(),
      target: target.getBoundingClientRect(),
      pad: RETICLE_ROI_PAD,
    });
    if (roi) return roi;
  }
  return computeCoverRoi(video);
}
