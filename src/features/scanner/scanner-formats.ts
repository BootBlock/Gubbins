/**
 * Scanner symbology selection (spec §6.6, §6.1 battery, §3 preferences).
 *
 * The §6.6 tiered decoder hints **four** symbologies by default (QR deep-links + the common
 * 1-D part labels). A user who only ever scans one kind of code can narrow the scanner to a
 * **single symbology**: the native `BarcodeDetector` and the off-thread zxing worker then both
 * try just that one format, cutting per-frame decode cost (the zxing `MultiFormatReader` tries
 * every hinted format, so one format is ~4× cheaper than four) — finishing the Phase-31 perf
 * residual without sacrificing flexibility for users who keep the default.
 *
 * This module is deliberately **main-thread-safe**: it carries no `@zxing/library` import, so
 * the preference, the native decoder and the Settings control can all reference it without
 * pulling the zxing core enum into the default bundle. The worker-only {@link ./zxing-decode}
 * maps these string keys to `BarcodeFormat` values.
 */

/** A scan-scope choice: every symbology, or exactly one. Mirrors the native format strings. */
export type ScannerSymbology = 'all' | 'qr_code' | 'code_128' | 'ean_13' | 'code_39';

/** The four symbologies Gubbins scans, in canonical order (QR deep-links + 1-D part labels). */
export const ALL_NATIVE_FORMATS = ['qr_code', 'code_128', 'ean_13', 'code_39'] as const;

/** The default scope: scan everything (the pre-Phase-34 behaviour — never a regression). */
export const DEFAULT_SCANNER_SYMBOLOGY: ScannerSymbology = 'all';

/** Choices for the Settings symbology control (spec §3), in the order they are shown. */
export const SCANNER_SYMBOLOGY_OPTIONS = [
  { value: 'all', label: 'All supported codes' },
  { value: 'qr_code', label: 'QR codes only' },
  { value: 'code_128', label: 'Code 128 only' },
  { value: 'ean_13', label: 'EAN-13 only' },
  { value: 'code_39', label: 'Code 39 only' },
] as const satisfies readonly { value: ScannerSymbology; label: string }[];

/**
 * The native `BarcodeDetector` / hint format list for a symbology: all four for `'all'`,
 * otherwise the single chosen format. Pure — the single source of truth both the native
 * decoder and (via {@link ./zxing-decode}) the worker derive their formats from.
 */
export function nativeFormatsFor(symbology: ScannerSymbology): readonly string[] {
  return symbology === 'all' ? ALL_NATIVE_FORMATS : [symbology];
}

/**
 * Coerce an arbitrary value (e.g. a stale persisted preference) to a valid
 * {@link ScannerSymbology}, falling back to {@link DEFAULT_SCANNER_SYMBOLOGY}. Keeps an
 * out-of-range value from ever reaching the decoder.
 */
export function normaliseSymbology(value: unknown): ScannerSymbology {
  return SCANNER_SYMBOLOGY_OPTIONS.some((o) => o.value === value)
    ? (value as ScannerSymbology)
    : DEFAULT_SCANNER_SYMBOLOGY;
}
