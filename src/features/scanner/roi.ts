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
 */

/** A crop rectangle in a video frame's own source-pixel coordinates. */
export interface FrameRoi {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

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
