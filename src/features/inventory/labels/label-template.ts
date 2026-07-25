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
 * (issue #331). {@link toBarcodeText} does the same for the *characters* it carries: a
 * value Code 128 cannot spell is transliterated or given up on, never quietly cut down to
 * the letters that happen to fit the symbology (issue #332).
 */
import { code128Modules, code128WidestModules } from './code128';

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
export const LABEL_COLUMNS_BOUNDS = { min: 1, max: 8 } as const;

/** Inclusive bounds for the rows-per-sheet control. */
export const LABEL_ROWS_BOUNDS = { min: 1, max: 20 } as const;

/** Inclusive bounds (mm) for an A4 sheet's page margin. */
export const SHEET_MARGIN_BOUNDS = { min: 0, max: 30 } as const;

/** Inclusive bounds (mm) for the gutter between labels on an A4 sheet. */
export const SHEET_GAP_BOUNDS = { min: 0, max: 25 } as const;

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
  'one label prints per page at the exact millimetre size — or **A4 sheet** to tile many',
  'labels across a page, either on plain paper or onto a sheet of sticker stock (choose',
  'which under **Sheet layout**).',
  '',
  'Common die-cut sizes and what they suit:',
  '',
  ...LABEL_SIZE_PRESETS.map((p) => `- **${p.label}** — ${p.use}`),
  '',
  'Pick **Custom…** to type an exact width × height in millimetres.',
].join('\n');

/*
 * A4 page geometry, in mm. {@link sheetCellSizeMm} tiles this page, and the sheet print
 * stylesheet in `label-sheet.ts` is built from the numbers it returns — so what the
 * controls report a label measures and what the printer lays down cannot drift apart.
 */
/** The short edge of an A4 page. */
export const A4_WIDTH_MM = 210;
/** The long edge of an A4 page. */
export const A4_HEIGHT_MM = 297;

/**
 * Floor (mm) on a derived sheet cell. A deliberately absurd custom layout (twenty rows
 * with a 25 mm gutter, say) asks for more page than A4 has; rather than emit a grid with
 * a negative row height, the cell bottoms out here and the controls' "each label
 * measures…" readout shows the user what they actually asked for.
 */
export const MIN_SHEET_CELL_MM = 5;

/**
 * How labels tile an A4 page — the geometry of a sheet of label stock.
 *
 * The label's own size is **derived** from this, never stored alongside it
 * ({@link sheetCellSizeMm}): a sheet whose labels, margins and gutters were recorded
 * separately could describe a tiling that does not fit the page, and nothing would say
 * which of the two numbers was wrong. Margins are symmetric (a sheet of stock is), and
 * the two gutters are independent because real stock routinely has one and not the other
 * — most sticker sheets butt their rows together and leave a gap between columns.
 */
export interface SheetLayout {
  /** Labels across the page (clamped to {@link LABEL_COLUMNS_BOUNDS}). */
  readonly columns: number;
  /** Labels down the page (clamped to {@link LABEL_ROWS_BOUNDS}). */
  readonly rows: number;
  /** Unprinted margin (mm) at the top and bottom of the page. */
  readonly marginTopMm: number;
  /** Unprinted margin (mm) at the left and right of the page. */
  readonly marginSideMm: number;
  /** Gutter (mm) between adjacent columns. */
  readonly columnGapMm: number;
  /** Gutter (mm) between adjacent rows. */
  readonly rowGapMm: number;
  /**
   * Draw a faint outline round each label. A cutting guide on plain paper; on pre-cut
   * stock it would print a grey rectangle inside every sticker, so named stock turns it
   * off.
   */
  readonly outline: boolean;
}

/**
 * The default A4 tiling: plain paper, generous margins and gutters, and a cut outline —
 * the layout to reach for when you are printing onto a blank sheet and cutting the
 * labels out yourself. Its numbers are chosen to divide the page exactly, so each label
 * comes out a round 60 × 42 mm.
 */
export const PLAIN_PAPER_SHEET_LAYOUT: SheetLayout = {
  columns: 3,
  rows: 6,
  marginTopMm: 10,
  marginSideMm: 10,
  columnGapMm: 5,
  rowGapMm: 5,
  outline: true,
};

/**
 * A named sheet of label stock: how it tiles A4, and what it is sold as.
 *
 * It carries no display copy. What each stock *suits* is prose a reader should get in
 * their own language, so it lives in the message catalog under
 * `inventory.labels.sheetStockUse.<id>` rather than beside the geometry here; the size and
 * count the picker shows are derived from the layout rather than written down.
 */
export interface SheetStockPreset {
  readonly id: string;
  /**
   * What a box of this stock is labelled with — the part codes a user matches against.
   * Blank for the plain-paper layout, which is not a product.
   */
  readonly code: string;
  readonly layout: SheetLayout;
}

/**
 * Common A4 sticker-sheet stock, largest label first, plus the plain-paper layout.
 *
 * The geometry is the published die-cut layout of each stock, so
 * {@link sheetCellSizeMm} derives exactly the label size printed on the box (a unit test
 * pins every one of them). Codes are given for matching a packet in a drawer — these are
 * the common trade designations, and equivalent stock from any manufacturer shares the
 * layout.
 */
export const SHEET_STOCK_PRESETS = [
  {
    id: 'plain',
    code: '',
    layout: PLAIN_PAPER_SHEET_LAYOUT,
  },
  {
    id: 'a4-2up',
    code: 'L7168 / J8168',
    layout: {
      columns: 1,
      rows: 2,
      marginTopMm: 5,
      marginSideMm: 5.2,
      columnGapMm: 0,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-4up',
    code: 'L7169 / J8169',
    layout: {
      columns: 2,
      rows: 2,
      marginTopMm: 9.5,
      marginSideMm: 4.65,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-8up',
    code: 'L7165 / J8165',
    layout: {
      columns: 2,
      rows: 4,
      marginTopMm: 13.1,
      marginSideMm: 4.65,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-14up',
    code: 'L7163 / J8163',
    layout: {
      columns: 2,
      rows: 7,
      marginTopMm: 15.15,
      marginSideMm: 4.65,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-18up',
    code: 'L7161 / J8161',
    layout: {
      columns: 3,
      rows: 6,
      marginTopMm: 8.7,
      marginSideMm: 7.25,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-21up',
    code: 'L7160 / J8160',
    layout: {
      columns: 3,
      rows: 7,
      marginTopMm: 15.15,
      marginSideMm: 7.25,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-24up',
    code: 'L7159 / J8159',
    layout: {
      columns: 3,
      rows: 8,
      marginTopMm: 12.9,
      marginSideMm: 7.25,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-40up',
    code: 'L7654',
    layout: {
      columns: 4,
      rows: 10,
      marginTopMm: 21.5,
      marginSideMm: 9.85,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
  {
    id: 'a4-65up',
    code: 'L7651',
    layout: {
      columns: 5,
      rows: 13,
      marginTopMm: 10.7,
      marginSideMm: 4.75,
      columnGapMm: 2.5,
      rowGapMm: 0,
      outline: false,
    },
  },
] as const satisfies readonly SheetStockPreset[];

/** The Select id standing for a user-entered custom sheet layout. */
export const SHEET_LAYOUT_CUSTOM_ID = 'custom';

/** Round a millimetre value to the hundredth — enough for any published stock geometry. */
function roundMm(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Format a millimetre value for display, without trailing zeroes: `63.5`, not `63.50`.
 */
export function formatMm(value: number): string {
  return String(roundMm(value));
}

/**
 * The size of one label under a sheet layout, in mm — what is left of the page once the
 * margins and gutters are taken out, divided between the columns and rows.
 *
 * Rounded **down** to the hundredth, so a whole page of rows can never add up to more
 * than the page has: the fraction of a millimetre given away keeps the last row of a
 * full sheet from tipping onto a page of its own. The tolerance absorbs binary
 * floating-point noise, so a stock that divides the page exactly still reports the round
 * size it is sold as (7 rows of 38.1 mm, not of 38.09).
 */
export function sheetCellSizeMm(layout: SheetLayout): { widthMm: number; heightMm: number } {
  const l = normaliseSheetLayout(layout);
  const across = A4_WIDTH_MM - l.marginSideMm * 2 - l.columnGapMm * (l.columns - 1);
  const down = A4_HEIGHT_MM - l.marginTopMm * 2 - l.rowGapMm * (l.rows - 1);
  const floorMm = (n: number) => Math.max(MIN_SHEET_CELL_MM, Math.floor(n * 100 + 1e-6) / 100);
  return { widthMm: floorMm(across / l.columns), heightMm: floorMm(down / l.rows) };
}

/** `60 × 42 mm` — one label's derived size under `layout`, for a caption or option label. */
export function formatSheetCellSize(layout: SheetLayout): string {
  const { widthMm, heightMm } = sheetCellSizeMm(layout);
  return `${formatMm(widthMm)} × ${formatMm(heightMm)} mm`;
}

/** How many labels a layout puts on one page — the count the picker leads with. */
export function sheetLabelCount(layout: SheetLayout): number {
  return clampColumns(layout.columns) * clampRows(layout.rows);
}

/**
 * A label layout. The four `show*` field flags govern the text block beneath the
 * code; `showText` governs the human-readable line printed under a Code 128 barcode
 * (the digits/letters the bars encode); `sheet` is how labels tile an A4 page.
 * `sizeMode` (+ `labelWidthMm`/`labelHeightMm`) selects the A4 grid vs a fixed physical
 * die-cut label.
 */
export interface LabelTemplate {
  readonly symbology: LabelSymbology;
  readonly showName: boolean;
  readonly showMpn: boolean;
  readonly showLocation: boolean;
  readonly showQuantity: boolean;
  /** Render the human-readable value under a Code 128 barcode. */
  readonly showText: boolean;
  /** How labels tile the printed A4 sheet (sheet mode only). */
  readonly sheet: SheetLayout;
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
  sheet: PLAIN_PAPER_SHEET_LAYOUT,
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
  if (!Number.isFinite(n)) return PLAIN_PAPER_SHEET_LAYOUT.columns;
  return Math.min(LABEL_COLUMNS_BOUNDS.max, Math.max(LABEL_COLUMNS_BOUNDS.min, n));
}

/**
 * Clamp/round an arbitrary value to a valid row count.
 *
 * @internal Exported for unit tests only.
 */
export function clampRows(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return PLAIN_PAPER_SHEET_LAYOUT.rows;
  return Math.min(LABEL_ROWS_BOUNDS.max, Math.max(LABEL_ROWS_BOUNDS.min, n));
}

/**
 * Clamp an arbitrary value to a millimetre measurement within `bounds`, falling back to
 * `fallback` when it is not a finite number.
 *
 * Kept to hundredths of a millimetre rather than whole ones: published label stock is
 * dimensioned in tenths (63.5 × 38.1 mm) and its margins in hundredths, and an imperial
 * size converts to a fraction too (4 × 6" is 101.6 × 152.4 mm). Rounding those to the
 * nearest whole millimetre would lose up to half a millimetre on every edge — enough,
 * over a column of labels, to walk the print off the stickers (issue #333).
 *
 * @internal Exported for unit tests only.
 */
export function clampMm(
  value: unknown,
  bounds: { readonly min: number; readonly max: number },
  fallback: number,
): number {
  const clamp = (n: number) => Math.min(bounds.max, Math.max(bounds.min, roundMm(n)));
  const n = Number(value);
  return clamp(Number.isFinite(n) ? n : fallback);
}

/**
 * Clamp an arbitrary value to a valid die-cut label edge (mm), falling back to
 * `fallback` (itself clamped) when the input is not a finite number.
 */
export function clampLabelDimension(value: unknown, fallback: number = LABEL_SIZE_BOUNDS.min): number {
  return clampMm(value, LABEL_SIZE_BOUNDS, fallback);
}

/**
 * Coerce an arbitrary value to a valid {@link SheetLayout}, falling back field-by-field
 * to {@link PLAIN_PAPER_SHEET_LAYOUT}. Every consumer — the controls, the derived label
 * size and the print stylesheet — goes through this, so none can be handed a layout the
 * others would read differently.
 */
export function normaliseSheetLayout(value: unknown): SheetLayout {
  const v = (value ?? {}) as Partial<Record<keyof SheetLayout, unknown>>;
  const base = PLAIN_PAPER_SHEET_LAYOUT;
  return {
    columns: clampColumns(v.columns),
    rows: clampRows(v.rows),
    marginTopMm: clampMm(v.marginTopMm, SHEET_MARGIN_BOUNDS, base.marginTopMm),
    marginSideMm: clampMm(v.marginSideMm, SHEET_MARGIN_BOUNDS, base.marginSideMm),
    columnGapMm: clampMm(v.columnGapMm, SHEET_GAP_BOUNDS, base.columnGapMm),
    rowGapMm: clampMm(v.rowGapMm, SHEET_GAP_BOUNDS, base.rowGapMm),
    outline: bool(v.outline, base.outline),
  };
}

/**
 * The Select id for a layout: the matching {@link SHEET_STOCK_PRESETS} entry when it is
 * one of the named stocks, else {@link SHEET_LAYOUT_CUSTOM_ID}. Lets the control drive
 * off the layout alone, with no separate "which preset" state to keep in sync.
 */
export function sheetLayoutSelection(layout: SheetLayout): string {
  const l = normaliseSheetLayout(layout);
  const preset = SHEET_STOCK_PRESETS.find((p) => sameSheetLayout(p.layout, l));
  return preset ? preset.id : SHEET_LAYOUT_CUSTOM_ID;
}

/**
 * Do two layouts tile the page identically?
 *
 * Deliberately **excludes** `outline`. What is on the sheet is its geometry; the cut
 * guide is ink drawn on top of it, offered as its own toggle beside the picker. Counting
 * it as part of the sheet's identity would mean ticking that toggle threw the picker out
 * of the named stock the user had just chosen and into "Custom…", with the six geometry
 * fields springing open — for a choice that changed no geometry at all.
 */
function sameSheetLayout(a: SheetLayout, b: SheetLayout): boolean {
  const x = normaliseSheetLayout(a);
  const y = normaliseSheetLayout(b);
  return (
    x.columns === y.columns &&
    x.rows === y.rows &&
    x.marginTopMm === y.marginTopMm &&
    x.marginSideMm === y.marginSideMm &&
    x.columnGapMm === y.columnGapMm &&
    x.rowGapMm === y.rowGapMm
  );
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
  const v = (value ?? {}) as Partial<Record<keyof LabelTemplate, unknown>> & { columns?: unknown };
  const symbology = SYMBOLOGIES.includes(v.symbology as LabelSymbology)
    ? (v.symbology as LabelSymbology)
    : DEFAULT_LABEL_TEMPLATE.symbology;
  // A template saved before sheet layouts existed carries a bare `columns` and nothing
  // else about the page. Keep the column count the user chose and take the rest from the
  // plain-paper layout, which is the tiling that count used to mean.
  const sheet =
    v.sheet == null && v.columns != null
      ? { ...PLAIN_PAPER_SHEET_LAYOUT, columns: clampColumns(v.columns) }
      : normaliseSheetLayout(v.sheet);
  return {
    symbology,
    showName: bool(v.showName, DEFAULT_LABEL_TEMPLATE.showName),
    showMpn: bool(v.showMpn, DEFAULT_LABEL_TEMPLATE.showMpn),
    showLocation: bool(v.showLocation, DEFAULT_LABEL_TEMPLATE.showLocation),
    showQuantity: bool(v.showQuantity, DEFAULT_LABEL_TEMPLATE.showQuantity),
    showText: bool(v.showText, DEFAULT_LABEL_TEMPLATE.showText),
    sheet,
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

/**
 * Letters and punctuation that Unicode decomposition deliberately leaves alone — `ß` is a
 * letter in its own right, not "s with a mark" — but which have a settled ASCII spelling a
 * reader recognises on sight. Unicode's own compatibility mappings say `ß` "expands to" `ss`
 * and `æ` to `ae`; they simply aren't applied by `normalize`, because they are not
 * round-trippable. A barcode value is exactly the place they *should* be applied: the point
 * is a scannable approximation, not a faithful copy.
 *
 * Deliberately confined to Latin letters and typographic punctuation. Nothing here invents a
 * reading — `£` has no ASCII spelling, so it is left to fail the encodability check below and
 * take the whole value down to the short-id fallback, rather than being guessed at.
 */
const BARCODE_TRANSLITERATIONS: Readonly<Record<string, string>> = {
  // Latin letters that carry no separable diacritic.
  ß: 'ss',
  ẞ: 'SS',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  Ð: 'D',
  ł: 'l',
  Ł: 'L',
  þ: 'th',
  Þ: 'TH',
  ħ: 'h',
  Ħ: 'H',
  ŧ: 't',
  Ŧ: 'T',
  ı: 'i',
  // Typographic punctuation a word processor or phone keyboard substitutes automatically:
  // curly quotes, the dash family, and the prime, multiplication and fraction-slash signs a
  // size is written with. Only the forms decomposition *leaves* need an entry — a double prime
  // arrives here as two single primes, and `½` as `1`, a fraction slash and `2`.
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '‐': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '×': 'x',
  '⁄': '/',
};

/**
 * The value a Code 128 should carry for `value`, or `null` when it has no faithful
 * Code-128-encodable form.
 *
 * Code Set B encodes printable ASCII (32..126) and nothing else, so a name like
 * `Café Störage` has to be dealt with somehow. Dropping the offending characters is the one
 * option that is never right: it prints `Caf Strage` — a value beneath a label whose name
 * line reads `Café Störage`, matching no record, and wrong in a way that looks deliberate
 * (issue #332).
 *
 * So each character is either **transliterated** or the whole value is **rejected**:
 *
 * 1. Compatibility-decompose (NFKD) and drop the combining marks left behind, so `é` becomes
 *    `e`, `ﬁ` becomes `fi` and a non-breaking space becomes a space. This is the step that
 *    covers the accented Latin alphabets, which is the common case.
 * 2. Apply {@link BARCODE_TRANSLITERATIONS} for the letters and punctuation decomposition
 *    leaves behind but which do have an agreed ASCII spelling.
 * 3. If **anything** unencodable remains — an emoji, a CJK or Cyrillic character, a currency
 *    sign — return `null`. A partly-representable name is not partly printed: the caller
 *    falls back to the short id, which is honestly opaque rather than quietly wrong.
 *
 * Invisible formatting characters (zero-width joiners and spaces, bidi marks) are stripped
 * rather than rejected — they contribute nothing a printed value could show, and one pasted
 * invisibly into a name should not cost the label its barcode.
 *
 * @internal Exported for unit tests only.
 */
export function toBarcodeText(value: string): string | null {
  let out = '';
  // Iterates by code point, so an astral character is examined whole rather than as a lone
  // surrogate that would fail the range check for the wrong reason.
  for (const ch of value
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/\s+/gu, ' ')) {
    out += BARCODE_TRANSLITERATIONS[ch] ?? ch;
  }
  const text = out.trim();
  if (text.length === 0) return null;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code > 126) return null;
  }
  return text;
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
 *
 * Measures the value **as it will actually encode**, so a compressible one (Code Set C
 * halves a run of digits) is allowed the extra room it genuinely occupies. Right for a
 * value the user chose and can see; see {@link barcodeFitsWidthUncompressed} for one they
 * cannot.
 */
export function barcodeFitsWidth(value: string, widthMm: number): boolean {
  const modules = barcodeModuleWidth(value);
  if (modules === null || modules <= 0) return false;
  return widthMm / modules >= MIN_BARCODE_MODULE_MM;
}

/**
 * As {@link barcodeFitsWidth}, but measuring `value` at its **widest** — as though Code 128
 * could not compress it at all ({@link code128WidestModules}) — so the answer depends only
 * on how many characters it has, never on which.
 *
 * This is what the short-id fallback is judged by. A record id is opaque to the user, and
 * Code Set C compresses an all-digit id to roughly two-thirds the width of one carrying
 * letters. Measured exactly, two records with equally long names on the same label size
 * would disagree about whether a fallback barcode fits — arbitrary from the outside, since
 * the deciding value is one nobody sees. Measured at its widest, "can this label carry a
 * barcode at all?" becomes a property of the label size alone (issue #331), at the cost of
 * turning down the few ids that would have squeaked through.
 */
export function barcodeFitsWidthUncompressed(value: string, widthMm: number): boolean {
  // Still asks the encoder whether the value is encodable at all; only the width is assumed.
  if (barcodeModuleWidth(value) === null) return false;
  const modules = code128WidestModules(value.length) + BARCODE_QUIET_ZONE_MODULES * 2;
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
 * name — put through {@link toBarcodeText}, which transliterates it to Code 128's ASCII
 * or gives up on it entirely. It is used whenever it prints wide enough to scan;
 * otherwise the value falls back to {@link shortId} — the id's first group, so short and
 * of a predictable width whatever the record. On a label too narrow for even that, no
 * barcode is printed at all: an unreadable symbol is worse than none, because it looks
 * like it should work (issue #331).
 *
 * The two are measured differently on purpose: the preferred value as it really encodes,
 * the fallback at its widest (see {@link barcodeFitsWidthUncompressed}), so `unprintable`
 * is decided by the label's size rather than by the shape of an id the user never sees.
 *
 * Pure — the printed sheet, the on-screen preview and the dialogs' warnings all derive
 * the same answer from this one place.
 */
export function fitBarcodeValue(preferred: string, id: string, widthMm: number): FittedBarcode {
  const wanted = toBarcodeText(preferred);
  if (wanted !== null && barcodeFitsWidth(wanted, widthMm)) return { value: wanted, fit: 'ok' };
  const short = shortId(id);
  if (barcodeFitsWidthUncompressed(short, widthMm)) {
    // `shortened` means a readable value was *cut down to fit* — what the print dialogs'
    // "too long for this label" warning goes on to say. A value with no encodable form at
    // all (a CJK name, an emoji) wasn't shortened and has nothing to do with the label's
    // size, and neither has an item with no MPN: both take the short id as the ordinary
    // path, as they always have. A short id reads as the opaque code it plainly is, so
    // nothing on the sticker misrepresents itself either way.
    return { value: short, fit: wanted !== null ? 'shortened' : 'ok' };
  }
  return { value: null, fit: 'unprintable' };
}
