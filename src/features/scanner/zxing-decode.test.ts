import { describe, it, expect } from 'vitest';
import { BarcodeFormat } from '@zxing/library';
import { createZxingDecode, zxingFormatsFor } from './zxing-decode';
import { ALL_NATIVE_FORMATS } from './scanner-formats';

/**
 * The shared zxing decode core (spec §6.6) — the single pipeline both fallback engines use.
 * A real barcode bitmap is impractical to synthesise in a unit test (that path is covered by
 * the browser smoke), so these assert the fail-soft wiring: a blank / zero-size frame yields
 * `null` rather than throwing, so an empty viewfinder simply produces no codes.
 */
describe('createZxingDecode — shared fallback decode pipeline (spec §6.6)', () => {
  it('returns null (not a throw) for a blank frame with no code', () => {
    const decode = createZxingDecode();
    const blank = new Uint8ClampedArray(32 * 32 * 4); // all-zero RGBA → no barcode
    expect(decode(blank, 32, 32)).toBeNull();
  });

  it('returns null for a zero-dimension frame without invoking zxing', () => {
    const decode = createZxingDecode();
    expect(decode(new Uint8ClampedArray(0), 0, 0)).toBeNull();
  });

  it('builds an independent reader per call (no shared mutable state across decoders)', () => {
    const a = createZxingDecode();
    const b = createZxingDecode();
    expect(a).not.toBe(b);
    expect(a(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
    expect(b(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
  });

  it('still fails soft when scoped to a single symbology (§6.6 single-format mode)', () => {
    const decode = createZxingDecode('qr_code');
    expect(decode(new Uint8ClampedArray(32 * 32 * 4), 32, 32)).toBeNull();
  });
});

describe('zxingFormatsFor — symbology → zxing BarcodeFormat hints (§6.6)', () => {
  it("'all' hints exactly the four scanned formats", () => {
    expect(zxingFormatsFor('all')).toEqual([
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_128,
      BarcodeFormat.EAN_13,
      BarcodeFormat.CODE_39,
    ]);
    expect(zxingFormatsFor('all')).toHaveLength(ALL_NATIVE_FORMATS.length);
  });

  it('a single symbology hints exactly one format — the perf win', () => {
    expect(zxingFormatsFor('qr_code')).toEqual([BarcodeFormat.QR_CODE]);
    expect(zxingFormatsFor('code_128')).toEqual([BarcodeFormat.CODE_128]);
    expect(zxingFormatsFor('ean_13')).toEqual([BarcodeFormat.EAN_13]);
    expect(zxingFormatsFor('code_39')).toEqual([BarcodeFormat.CODE_39]);
  });
});
