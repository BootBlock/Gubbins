/**
 * The shared zxing decode core for the §6.6 WASM fallback (spec §6.6, §2.4.3 native-first).
 *
 * Both off-thread fallback engines decode through this one pipeline, so the scanned
 * symbology set and the zxing wiring live in a single place:
 *  - the **OffscreenCanvas worker path** (`engine: 'wasm'`, Phase 31) draws a transferred
 *    `ImageBitmap` onto an `OffscreenCanvas`, reads back its RGBA pixels and decodes them;
 *  - the **main-thread-capture path** (`engine: 'wasm-canvas'`, Phase 33) captures the frame
 *    on the main thread with a regular 2-D `<canvas>` (the API Safari < 16.4 has — only
 *    `OffscreenCanvas` is missing there) and transfers the raw RGBA pixels to the *same*
 *    decode worker, which decodes them here **without** touching `OffscreenCanvas`.
 *
 * Keeping the reader + pixel→luminance→decode steps here means importing this module is what
 * pulls `@zxing/library` into the worker's separate module graph; the main thread never
 * imports it, so the zxing core never enters the default bundle.
 */
import {
  MultiFormatReader,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  DecodeHintType,
  BarcodeFormat,
} from '@zxing/library';
import { rgbaToLuminance } from './luminance';
import { type ScannerSymbology } from './scanner-formats';

/** zxing `BarcodeFormat` per scanned symbology key — the *only* place the enum is named. */
const ZXING_FORMAT: Record<Exclude<ScannerSymbology, 'all'>, BarcodeFormat> = {
  qr_code: BarcodeFormat.QR_CODE,
  code_128: BarcodeFormat.CODE_128,
  ean_13: BarcodeFormat.EAN_13,
  code_39: BarcodeFormat.CODE_39,
};

/**
 * Map a {@link ScannerSymbology} to the zxing `POSSIBLE_FORMATS` hint list: all four for
 * `'all'`, otherwise the single chosen format. Restricting the `MultiFormatReader` to one
 * format is ~4× less per-frame work (it tries every hinted format) — the §6.6 single-format
 * perf win. Pure, so the format selection is unit-testable without a real barcode.
 */
export function zxingFormatsFor(symbology: ScannerSymbology): BarcodeFormat[] {
  return symbology === 'all'
    ? [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.CODE_39]
    : [ZXING_FORMAT[symbology]];
}

/** Decode an RGBA frame's pixels to a code string, or `null` when none is found. */
export type RgbaDecoder = (rgba: Uint8ClampedArray, width: number, height: number) => string | null;

/**
 * Build a reusable {@link RgbaDecoder}: a single hinted `MultiFormatReader` driven with
 * `decodeWithState` (the documented continuous-scan fast path). The returned function reduces
 * RGBA → luminance (the pure {@link rgbaToLuminance}) and decodes; a frame with no code (zxing's
 * `NotFoundException`) or any transient decode error yields `null`, matching the native
 * decoder's fail-soft contract.
 *
 * `symbology` scopes which formats the reader hints (default: all four, §6.6). A single-format
 * scope makes each frame cheaper to decode — the §6.6 single-format mode.
 */
export function createZxingDecode(symbology: ScannerSymbology = 'all'): RgbaDecoder {
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, zxingFormatsFor(symbology));
  reader.setHints(hints);

  return (rgba, width, height) => {
    if (width === 0 || height === 0) return null;
    const luminances = rgbaToLuminance(rgba, width, height);
    const source = new RGBLuminanceSource(luminances, width, height);
    const binary = new BinaryBitmap(new HybridBinarizer(source));
    try {
      return reader.decodeWithState(binary).getText() || null;
    } catch {
      // NotFoundException (no code in frame) and any transient decode error → no codes.
      return null;
    }
  };
}
