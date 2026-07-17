/**
 * Scanner symbology selection (spec §6.6, §6.1 battery, §3 preferences).
 *
 * The §6.6 tiered decoder hints QR/2-D codes, the common 1-D part labels and the full retail
 * GTIN family by default (see {@link ALL_NATIVE_FORMATS}). A user who only ever scans one kind of
 * code can narrow the scanner to a **single symbology**: the native `BarcodeDetector` and the
 * off-thread zxing worker then both try just that one format, cutting per-frame decode cost (the
 * zxing `MultiFormatReader` tries every hinted format, so one format is markedly cheaper than the
 * whole set) — the Phase-31 perf residual, without sacrificing flexibility for the default user.
 *
 * The single-symbology choices cover **every** format both the native Barcode Detection API and
 * the zxing fallback support, so the Settings picker offers each one and it is honoured end to end
 * (issue #59): QR / Data Matrix / Aztec / PDF417 2-D codes, the retail GTIN family (EAN-13, EAN-8,
 * UPC-A, UPC-E) and the 1-D part labels (Code 128 / 39 / 93, Codabar, ITF).
 *
 * This module is deliberately **main-thread-safe**: it carries no `@zxing/library` import, so the
 * preference, the native decoder and the Settings control can all reference it without pulling the
 * zxing core enum into the default bundle. The worker-only {@link ./zxing-decode} maps these string
 * keys to `BarcodeFormat` values.
 */

/**
 * A scan-scope choice: every supported symbology, or exactly one. The single-format keys mirror the
 * native Barcode Detection API's own format strings, so a chosen key is a valid native `formats`
 * entry as-is and {@link ./zxing-decode} maps it to the matching zxing `BarcodeFormat`.
 */
export type ScannerSymbology =
  | 'all'
  | 'qr_code'
  | 'data_matrix'
  | 'aztec'
  | 'pdf417'
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'upc_e'
  | 'code_128'
  | 'code_39'
  | 'code_93'
  | 'codabar'
  | 'itf';

/**
 * Every symbology Gubbins scans by default, in canonical order: the 2-D codes (QR / Data Matrix /
 * Aztec / PDF417), the **full retail GTIN family** (EAN-13, EAN-8, UPC-A, UPC-E) and the common
 * 1-D part labels (Code 128 / 39 / 93, Codabar, ITF). Hinting the whole supported set (rather than
 * just EAN-13) means a small `ean_8` package code, a North-American `upc_a`/`upc_e` code or a 1-D
 * part label is actually attempted rather than missed — a common reason a clearly-visible barcode
 * "won't scan" (issue #59). Every retail width is validated by `parseGtin`, so the recognised set
 * stays consistent end to end; any other symbology is returned to the caller verbatim.
 */
export const ALL_NATIVE_FORMATS = [
  'qr_code',
  'data_matrix',
  'aztec',
  'pdf417',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'itf',
] as const;

/** The default scope: scan everything (the pre-Phase-34 behaviour — never a regression). */
export const DEFAULT_SCANNER_SYMBOLOGY: ScannerSymbology = 'all';

/** Choices for the Settings symbology control (spec §3), in the order they are shown. */
export const SCANNER_SYMBOLOGY_OPTIONS = [
  { value: 'all', label: 'All supported codes' },
  { value: 'qr_code', label: 'QR code' },
  { value: 'data_matrix', label: 'Data Matrix' },
  { value: 'aztec', label: 'Aztec' },
  { value: 'pdf417', label: 'PDF417' },
  { value: 'ean_13', label: 'EAN-13' },
  { value: 'ean_8', label: 'EAN-8' },
  { value: 'upc_a', label: 'UPC-A' },
  { value: 'upc_e', label: 'UPC-E' },
  { value: 'code_128', label: 'Code 128' },
  { value: 'code_39', label: 'Code 39' },
  { value: 'code_93', label: 'Code 93' },
  { value: 'codabar', label: 'Codabar' },
  { value: 'itf', label: 'ITF (Interleaved 2 of 5)' },
] as const satisfies readonly { value: ScannerSymbology; label: string }[];

/**
 * The native `BarcodeDetector` / hint format list for a symbology: every supported format for
 * `'all'`, otherwise the single chosen format. Pure — the single source of truth both the native
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
