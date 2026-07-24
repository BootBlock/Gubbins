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
 *
 * {@link fitBarcodeValue} applies the same defensiveness to the *printed* result: a
 * Code 128 is only as readable as its narrowest bar, so a value too long for the label
 * it must fit is swapped for a short id — or dropped — rather than printed as a smear
 * (issue #331).
 */
import { code128Modules } from './code128';

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
 * How a printed label is sized:
 * - `sheet`   — tile many labels in a grid across an ordinary A4 page (`columns` wide).
 * - `die-cut` — one label per page at an exact physical size (`labelWidthMm` ×
 *   `labelHeightMm`), for a thermal / die-cut label printer (e.g. Niimbot).
 */
export type LabelSizeMode = 'sheet' | 'die-cut';

/** Inclusive bounds (mm) for a custom die-cut label edge. */
export const LABEL_SIZE_BOUNDS = { min: 10, max: 300 } as const;

/** The Select id standing for the A4-grid (`sheet`) size mode. */
export const LABEL_SIZE_SHEET_ID = 'sheet';
/** The Select id standing for a user-entered custom die-cut size. */
export const LABEL_SIZE_CUSTOM_ID = 'custom';

/** A named physical label size (width × height in mm) for a die-cut / thermal printer. */
export interface LabelSizePreset {
  readonly id: string;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
  /** What this size is typically used for — drives the size control's InfoHint copy. */
  readonly use: string;
}

/**
 * Common thermal / die-cut label sizes, grounded in the roll sizes stocked for popular
 * label printers (Niimbot B-series and equivalents) plus the standard 4×6" shipping
 * label. Width × height in mm, ordered smallest-footprint-first among the everyday sizes.
 */
export const LABEL_SIZE_PRESETS = [
  {
    id: '40x30',
    label: '40 × 30 mm',
    widthMm: 40,
    heightMm: 30,
    use: 'The most common product & asset label — fits a QR plus a line or two of text.',
  },
  {
    id: '50x30',
    label: '50 × 30 mm',
    widthMm: 50,
    heightMm: 30,
    use: 'Wider product, shelf & barcode labels where a Code 128 needs more room.',
  },
  {
    id: '40x20',
    label: '40 × 20 mm',
    widthMm: 40,
    heightMm: 20,
    use: 'Small parts, cable flags & compact shelf tags.',
  },
  {
    id: '30x15',
    label: '30 × 15 mm',
    widthMm: 30,
    heightMm: 15,
    use: 'Tiny component, drawer & jewellery labels.',
  },
  {
    id: '50x50',
    label: '50 × 50 mm',
    widthMm: 50,
    heightMm: 50,
    use: 'Square labels for bins, jars & boxes.',
  },
  {
    id: '40x60',
    label: '40 × 60 mm',
    widthMm: 40,
    heightMm: 60,
    use: 'Taller labels for storage boxes & multi-line detail.',
  },
  {
    id: '50x80',
    label: '50 × 80 mm',
    widthMm: 50,
    heightMm: 80,
    use: 'Large labels for cartons & bin fronts.',
  },
  {
    id: '100x150',
    label: '100 × 150 mm',
    widthMm: 100,
    heightMm: 150,
    use: 'Shipping / parcel labels (4 × 6").',
  },
] as const satisfies readonly LabelSizePreset[];

/** Rich-Markdown help for the label-size control (an {@link LABEL_SIZE_PRESETS} rundown). */
export const LABEL_SIZE_HINT = [
  'Choose a **physical label size** for a thermal / die-cut printer (e.g. Niimbot) —',
  'one label prints per page at the exact millimetre size — or **A4 sheet** to tile',
  'many labels across ordinary paper.',
  '',
  'Common die-cut sizes and what they suit:',
  '',
  ...LABEL_SIZE_PRESETS.map((p) => `- **${p.label}** — ${p.use}`),
  '',
  'Pick **Custom…** to type an exact width × height in millimetres.',
].join('\n');

/**
 * A label layout. The four `show*` field flags govern the text block beneath the
 * code; `showText` governs the human-readable line printed under a Code 128 barcode
 * (the digits/letters the bars encode); `columns` is how many labels fit across an
 * A4 sheet. `sizeMode` (+ `labelWidthMm`/`labelHeightMm`) selects the A4 grid vs a
 * fixed physical die-cut label.
 */
export interface LabelTemplate {
  readonly symbology: LabelSymbology;
  readonly showName: boolean;
  readonly showMpn: boolean;
  readonly showLocation: boolean;
  readonly showQuantity: boolean;
  /** Render the human-readable value under a Code 128 barcode. */
  readonly showText: boolean;
  /** Labels per row on the printed A4 sheet (clamped to {@link LABEL_COLUMNS_BOUNDS}). */
  readonly columns: number;
  /** Sheet grid vs a fixed physical die-cut label. */
  readonly sizeMode: LabelSizeMode;
  /** Physical label width in mm (die-cut mode; clamped to {@link LABEL_SIZE_BOUNDS}). */
  readonly labelWidthMm: number;
  /** Physical label height in mm (die-cut mode; clamped to {@link LABEL_SIZE_BOUNDS}). */
  readonly labelHeightMm: number;
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
  // Defaults to the A4 grid (pre-size-mode behaviour); the die-cut dimensions seed the
  // "Custom…" inputs and the 40×30 preset when a physical printer is first chosen.
  sizeMode: 'sheet',
  labelWidthMm: 40,
  labelHeightMm: 30,
};

const SYMBOLOGIES: readonly LabelSymbology[] = LABEL_SYMBOLOGY_OPTIONS.map((o) => o.value);

/**
 * Clamp/round an arbitrary value to a valid integer column count.
 *
 * @internal Exported for unit tests only.
 */
export function clampColumns(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_LABEL_TEMPLATE.columns;
  return Math.min(LABEL_COLUMNS_BOUNDS.max, Math.max(LABEL_COLUMNS_BOUNDS.min, n));
}

/**
 * Clamp/round an arbitrary value to a valid die-cut label edge (mm), falling back to
 * `fallback` (itself clamped) when the input is not a finite number.
 */
export function clampLabelDimension(value: unknown, fallback: number = LABEL_SIZE_BOUNDS.min): number {
  const clamp = (n: number) => Math.min(LABEL_SIZE_BOUNDS.max, Math.max(LABEL_SIZE_BOUNDS.min, n));
  const n = Math.round(Number(value));
  return clamp(Number.isFinite(n) ? n : Math.round(fallback));
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
    sizeMode: v.sizeMode === 'die-cut' ? 'die-cut' : 'sheet',
    labelWidthMm: clampLabelDimension(v.labelWidthMm, DEFAULT_LABEL_TEMPLATE.labelWidthMm),
    labelHeightMm: clampLabelDimension(v.labelHeightMm, DEFAULT_LABEL_TEMPLATE.labelHeightMm),
  };
}

/**
 * The Select id for a template's current size: {@link LABEL_SIZE_SHEET_ID} in sheet mode,
 * a matching {@link LABEL_SIZE_PRESETS} id when the die-cut dimensions equal a preset, or
 * {@link LABEL_SIZE_CUSTOM_ID} for a bespoke die-cut size. Lets the control drive off the
 * template alone (no separate "which preset" state to keep in sync).
 */
export function labelSizeSelection(template: {
  readonly sizeMode: LabelSizeMode;
  readonly labelWidthMm: number;
  readonly labelHeightMm: number;
}): string {
  if (template.sizeMode === 'sheet') return LABEL_SIZE_SHEET_ID;
  const preset = LABEL_SIZE_PRESETS.find(
    (p) => p.widthMm === template.labelWidthMm && p.heightMm === template.labelHeightMm,
  );
  return preset ? preset.id : LABEL_SIZE_CUSTOM_ID;
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
 * Quiet zone, in modules, printed either side of a Code 128 — the ISO/IEC 15417 minimum
 * of 10X. Part of the symbol's printed width, so {@link barcodeModuleWidth} counts it and
 * every label renderer passes it as the encoder's `margin`.
 */
export const BARCODE_QUIET_ZONE_MODULES = 10;

/**
 * The narrowest a single Code 128 module (its "X-dimension") may print and still be read,
 * in millimetres.
 *
 * Code 128 spends 11 modules per character, so a long value squeezed into a fixed label
 * width collapses every bar towards nothing — a scanner sees a grey smear, and no amount
 * of print quality recovers it. 0.19 mm (7.5 mil) is the usual lower bound for close-range
 * laser/imager reading, so it is treated here as a hard floor: below it a symbol is
 * unreadable in practice. It is not a quality target — general-distribution specifications
 * ask for a good deal more (0.25 mm and up), so a value that merely clears this floor is
 * still better printed larger where there is room.
 */
export const MIN_BARCODE_MODULE_MM = 0.19;

/**
 * The printed width, in modules, of the Code 128 symbol encoding `value` — bars plus the
 * {@link BARCODE_QUIET_ZONE_MODULES} quiet zone either side — or `null` when `value`
 * cannot be encoded at all (empty, or carrying a character outside Code Set B).
 */
export function barcodeModuleWidth(value: string): number | null {
  try {
    return code128Modules(value).length + BARCODE_QUIET_ZONE_MODULES * 2;
  } catch {
    return null;
  }
}

/**
 * Would `value` print as a *readable* Code 128 across `widthMm` of label — i.e. is each
 * module at least {@link MIN_BARCODE_MODULE_MM} wide? `false` for a value that cannot be
 * encoded at all.
 */
export function barcodeFitsWidth(value: string, widthMm: number): boolean {
  const modules = barcodeModuleWidth(value);
  if (modules === null || modules <= 0) return false;
  return widthMm / modules >= MIN_BARCODE_MODULE_MM;
}

/**
 * What became of a label's preferred barcode value at the size it will print:
 * - `ok`          — it fits (or there was no preferred value and the short id fits).
 * - `shortened`   — it would have printed too small to scan, so the short id is used.
 * - `unprintable` — not even the short id fits; the label prints without a barcode.
 */
export type BarcodeFit = 'ok' | 'shortened' | 'unprintable';

/** The chosen barcode value (`null` when none can print) and why — see {@link BarcodeFit}. */
export interface FittedBarcode {
  readonly value: string | null;
  readonly fit: BarcodeFit;
}

/**
 * Choose the value a label's Code 128 encodes, given the width it has to print across.
 *
 * `preferred` is the meaningful, human-facing value — an item's MPN/SKU, a location's
 * name — sanitised to encodable ASCII. It is used whenever it prints wide enough to
 * scan; otherwise the value falls back to {@link shortId} — the id's first group, so
 * short and of a predictable width whatever the record. On a label too narrow for even
 * that, no barcode is printed at all: an unreadable symbol is worse than none, because
 * it looks like it should work (issue #331).
 *
 * Pure — the printed sheet, the on-screen preview and the dialogs' warnings all derive
 * the same answer from this one place.
 */
export function fitBarcodeValue(preferred: string, id: string, widthMm: number): FittedBarcode {
  const wanted = toEncodableAscii(preferred);
  if (wanted.length > 0 && barcodeFitsWidth(wanted, widthMm)) return { value: wanted, fit: 'ok' };
  const short = shortId(id);
  if (barcodeFitsWidth(short, widthMm)) {
    // No preferred value to lose (an item with no MPN) is the ordinary path, not a downgrade.
    return { value: short, fit: wanted.length > 0 ? 'shortened' : 'ok' };
  }
  return { value: null, fit: 'unprintable' };
}
