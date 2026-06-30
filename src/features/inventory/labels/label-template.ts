/**
 * Label template model (Phase 73 "Label customisation").
 *
 * A {@link LabelTemplate} describes *how* a printable label looks — which code
 * (symbology) it carries, which text fields are shown, and how many fit across a
 * sheet. It is a **device-local Tier-2 preference** (persisted in localStorage via
 * `usePreferencesStore`, mirroring the scanner symbology / dashboard layout seams):
 * label layout is a printer/paper concern, not inventory data, so it is never synced.
 *
 * Everything here is pure and unit-tested. {@link normaliseLabelTemplate} coerces an
 * arbitrary (e.g. stale persisted) value back to a valid template so a malformed
 * preference can never reach the label renderer — the same defensive pattern as the
 * scanner's `normaliseSymbology`.
 */

/**
 * Which code a label carries:
 * - `qr`      — a 2-D QR of the item/location deep-link (a phone camera opens the app).
 * - `barcode` — a 1-D Code 128 of the item's MPN/SKU (a handheld scanner looks it up).
 * - `both`    — QR above, barcode below.
 * - `none`    — text only (a plain printed tag).
 */
export type LabelSymbology = 'qr' | 'barcode' | 'both' | 'none';

/** Symbology choices for the print-dialog control, in the order they are shown. */
export const LABEL_SYMBOLOGY_OPTIONS = [
  { value: 'qr', label: 'QR code' },
  { value: 'barcode', label: 'Barcode (Code 128)' },
  { value: 'both', label: 'QR + barcode' },
  { value: 'none', label: 'Text only' },
] as const satisfies readonly { value: LabelSymbology; label: string }[];

/** Inclusive bounds for the columns-per-sheet control. */
export const LABEL_COLUMNS_BOUNDS = { min: 1, max: 4 } as const;

/**
 * A label layout. The four `show*` field flags govern the text block beneath the
 * code; `showText` governs the human-readable line printed under a Code 128 barcode
 * (the digits/letters the bars encode); `columns` is how many labels fit across an
 * A4 sheet.
 */
export interface LabelTemplate {
  readonly symbology: LabelSymbology;
  readonly showName: boolean;
  readonly showMpn: boolean;
  readonly showLocation: boolean;
  readonly showQuantity: boolean;
  /** Render the human-readable value under a Code 128 barcode. */
  readonly showText: boolean;
  /** Labels per row on the printed sheet (clamped to {@link LABEL_COLUMNS_BOUNDS}). */
  readonly columns: number;
}

/**
 * The default template — the pre-Phase-73 behaviour (a QR with the item name) so an
 * untouched preference prints exactly the labels it always did (never a regression).
 */
export const DEFAULT_LABEL_TEMPLATE: LabelTemplate = {
  symbology: 'qr',
  showName: true,
  showMpn: false,
  showLocation: false,
  showQuantity: false,
  showText: true,
  columns: 3,
};

const SYMBOLOGIES: readonly LabelSymbology[] = LABEL_SYMBOLOGY_OPTIONS.map((o) => o.value);

/** Clamp/round an arbitrary value to a valid integer column count. */
export function clampColumns(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_LABEL_TEMPLATE.columns;
  return Math.min(LABEL_COLUMNS_BOUNDS.max, Math.max(LABEL_COLUMNS_BOUNDS.min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce an arbitrary value (a stale/partial persisted preference, say) to a valid
 * {@link LabelTemplate}, falling back field-by-field to {@link DEFAULT_LABEL_TEMPLATE}.
 * Keeps a malformed value from ever reaching the renderer.
 */
export function normaliseLabelTemplate(value: unknown): LabelTemplate {
  const v = (value ?? {}) as Partial<Record<keyof LabelTemplate, unknown>>;
  const symbology = SYMBOLOGIES.includes(v.symbology as LabelSymbology)
    ? (v.symbology as LabelSymbology)
    : DEFAULT_LABEL_TEMPLATE.symbology;
  return {
    symbology,
    showName: bool(v.showName, DEFAULT_LABEL_TEMPLATE.showName),
    showMpn: bool(v.showMpn, DEFAULT_LABEL_TEMPLATE.showMpn),
    showLocation: bool(v.showLocation, DEFAULT_LABEL_TEMPLATE.showLocation),
    showQuantity: bool(v.showQuantity, DEFAULT_LABEL_TEMPLATE.showQuantity),
    showText: bool(v.showText, DEFAULT_LABEL_TEMPLATE.showText),
    columns: clampColumns(v.columns),
  };
}

/** Does this template render a Code 128 barcode (either alone or beside the QR)? */
export function templateHasBarcode(template: LabelTemplate): boolean {
  return template.symbology === 'barcode' || template.symbology === 'both';
}

/** Does this template render a QR code (either alone or beside the barcode)? */
export function templateHasQr(template: LabelTemplate): boolean {
  return template.symbology === 'qr' || template.symbology === 'both';
}

/**
 * The short, human-friendly form of an id used as a Code 128 fallback value — the
 * first hyphen-delimited group of a UUID, upper-cased (e.g. `A1B2C3D4`). Always
 * Code-128-encodable (hex digits only), so it is a safe last resort.
 */
export function shortId(id: string): string {
  const first = id.split('-')[0] ?? id;
  return (first || id).toUpperCase();
}

/** Strip any character a Code 128 Code-B cannot encode (outside ASCII 32..126). */
function toEncodableAscii(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) out += ch;
  }
  return out.trim();
}

/**
 * The value a label's Code 128 barcode encodes for an item: its MPN/SKU when set
 * (sanitised to encodable ASCII), else a short form of its id. Pure — the barcode
 * renderer and the on-screen preview derive the same value from this one place.
 */
export function labelBarcodeValue(item: { readonly id: string; readonly mpn?: string | null }): string {
  const mpn = toEncodableAscii(item.mpn ?? '');
  return mpn.length > 0 ? mpn : shortId(item.id);
}
