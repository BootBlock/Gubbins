/**
 * Pure RGBA→grayscale reduction for the off-thread barcode decoder (spec §6.6).
 *
 * The §6.6 WASM fallback decode runs in a Web Worker (see {@link ./barcode-decode.worker}):
 * a video frame is captured to an `ImageBitmap`, drawn onto an `OffscreenCanvas`, read back
 * as RGBA `ImageData`, then reduced here to a single luminance byte per pixel before being
 * handed to zxing's `RGBLuminanceSource`. Keeping this conversion pure (no DOM, no zxing)
 * makes the perceptually-correct weighting unit-testable without a worker or WASM.
 */

/**
 * Reduce an RGBA pixel buffer to one luminance byte per pixel, dropping alpha.
 *
 * Uses zxing's own ARGB→luma weighting `(r + 2·g + b) >> 2` so the produced bytes match
 * what `RGBLuminanceSource` would derive from raw ARGB pixels — green dominates human
 * brightness perception, so it is weighted twice as heavily as red and blue.
 *
 * @param data   RGBA bytes, length `width · height · 4` (e.g. `ImageData.data`).
 * @param width  Frame width in pixels.
 * @param height Frame height in pixels.
 * @returns A `Uint8ClampedArray` of length `width · height`, one luminance byte per pixel.
 */
export function rgbaToLuminance(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const luminances = new Uint8ClampedArray(width * height);
  for (let i = 0; i < luminances.length; i++) {
    const o = i * 4;
    // Bounds are provable from the loop limit; reads are within `data` (length ≥ 4·count).
    luminances[i] = (data[o]! + 2 * data[o + 1]! + data[o + 2]!) >> 2;
  }
  return luminances;
}
