import { describe, it, expect } from 'vitest';
import {
  SCANNER_SYMBOLOGY_OPTIONS,
  DEFAULT_SCANNER_SYMBOLOGY,
  ALL_NATIVE_FORMATS,
  nativeFormatsFor,
  normaliseSymbology,
  type ScannerSymbology,
} from './scanner-formats';

/**
 * The pure symbology-selection helper behind the §6.6 single-format scan mode. Lives
 * on the main thread (no zxing import), so it is the source of truth the native
 * `BarcodeDetector` formats and the worker's zxing hints both derive from.
 */
describe('nativeFormatsFor — symbology → native BarcodeDetector formats (§6.6)', () => {
  it("'all' hints every scanned symbology, in canonical order", () => {
    expect(nativeFormatsFor('all')).toEqual(ALL_NATIVE_FORMATS);
  });

  it('a single symbology hints only itself', () => {
    expect(nativeFormatsFor('qr_code')).toEqual(['qr_code']);
    expect(nativeFormatsFor('code_128')).toEqual(['code_128']);
    expect(nativeFormatsFor('ean_13')).toEqual(['ean_13']);
    expect(nativeFormatsFor('code_39')).toEqual(['code_39']);
  });

  it('every single-format choice narrows the four-format default to one', () => {
    for (const opt of SCANNER_SYMBOLOGY_OPTIONS) {
      const formats = nativeFormatsFor(opt.value);
      expect(formats.length).toBe(opt.value === 'all' ? ALL_NATIVE_FORMATS.length : 1);
      // Every hinted format is one of the canonical four (no stray strings).
      for (const f of formats) expect(ALL_NATIVE_FORMATS).toContain(f);
    }
  });
});

describe('normaliseSymbology — guard a persisted/arbitrary value (§2.1 Tier-2)', () => {
  it('passes through each valid symbology unchanged', () => {
    const valid: ScannerSymbology[] = ['all', 'qr_code', 'code_128', 'ean_13', 'code_39'];
    for (const v of valid) expect(normaliseSymbology(v)).toBe(v);
  });

  it('falls back to the default for an unknown / stale / non-string value', () => {
    expect(normaliseSymbology('pdf_417')).toBe(DEFAULT_SCANNER_SYMBOLOGY);
    expect(normaliseSymbology(undefined)).toBe(DEFAULT_SCANNER_SYMBOLOGY);
    expect(normaliseSymbology(42)).toBe(DEFAULT_SCANNER_SYMBOLOGY);
    expect(normaliseSymbology(null)).toBe(DEFAULT_SCANNER_SYMBOLOGY);
  });

  it('defaults to scanning all symbologies (no regression from the pre-Phase-34 behaviour)', () => {
    expect(DEFAULT_SCANNER_SYMBOLOGY).toBe('all');
  });
});

describe('SCANNER_SYMBOLOGY_OPTIONS — the Settings control choices (§3)', () => {
  it('offers "all" plus each of the four scanned symbologies, with labels', () => {
    expect(SCANNER_SYMBOLOGY_OPTIONS.map((o) => o.value)).toEqual([
      'all',
      'qr_code',
      'code_128',
      'ean_13',
      'code_39',
    ]);
    for (const o of SCANNER_SYMBOLOGY_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });
});
