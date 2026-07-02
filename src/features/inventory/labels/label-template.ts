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

/** Clamp/round an arbitrary value to a valid integer column count. */
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
 * The value a label's Code 128 barcode encodes for an item: its MPN/SKU when set
 * (sanitised to encodable ASCII), else a short form of its id. Pure — the barcode
 * renderer and the on-screen preview derive the same value from this one place.
 */
export function labelBarcodeValue(item: { readonly id: string; readonly mpn?: string | null }): string {
  const mpn = toEncodableAscii(item.mpn ?? '');
  return mpn.length > 0 ? mpn : shortId(item.id);
}
