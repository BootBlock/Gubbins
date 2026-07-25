/**
 * Template-aware printable label sheet (Phase 73 "Label customisation", extends the
 * Phase-49 batch QR sheet).
 *
 * The Phase-49 sheet printed a fixed grid of QR-plus-name labels. This generalises it
 * to a {@link LabelTemplate}: the chosen symbology (QR / Code 128 barcode / both /
 * none), the selected text fields, and how the sheet tiles an A4 page. The lean hand-rolled
 * encoders are reused — {@link qrSvgOrNull} (§2.4.3 native/no-bloat) and {@link code128Svg}
 * — and the canonical deep-link payload {@link buildItemQrUrl}.
 *
 * All logic here is pure and unit-tested: {@link toLabelCells} resolves each item to a
 * {@link LabelCell} (the structured code SVGs + text lines) shared by the on-screen
 * preview AND the printed sheet, so the two can never diverge; {@link buildLabelSheetHtml}
 * returns a complete, self-contained HTML document the thin DOM glue merely prints.
 */
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import { qrSvgOrNull } from '@/features/scanner/qr-code';
import { code128Svg, code128SvgSize } from './code128';
import {
  BARCODE_QUIET_ZONE_MODULES,
  DEFAULT_LABEL_TEMPLATE,
  clampLabelDimension,
  fitBarcodeValue,
  fitQrToSize,
  formatMm,
  normaliseSheetLayout,
  sheetCellSizeMm,
  templateHasBarcode,
  templateHasQr,
  type BarcodeFit,
  type LabelTemplate,
  type QrFit,
  type SheetLayout,
} from './label-template';

/** The item fields a label may surface (all but id/name optional). */
export interface LabelItem {
  readonly id: string;
  readonly name: string;
  readonly mpn?: string | null;
  readonly locationName?: string | null;
  readonly quantity?: number | null;
}

/** A resolved label: the deep-link, the rendered code SVGs, and the text lines. */
export interface LabelCell {
  readonly id: string;
  readonly name: string;
  /** The deep-link URL behind the QR. */
  readonly url: string;
  /** Rendered QR SVG, or `null` when the template hides the QR. */
  readonly qrSvg: string | null;
  /** Rendered Code 128 SVG, or `null` when the template hides the barcode. */
  readonly barcodeSvg: string | null;
  /** The value encoded by the barcode (for the preview caption / tests), or `null`. */
  readonly barcodeValue: string | null;
  /**
   * How the preferred barcode value fared at this label's printed size, or `null` when
   * the template draws no barcode. Drives the print dialogs' "shortened"/"too narrow"
   * warnings (issue #331).
   */
  readonly barcodeFit: BarcodeFit | null;
  /**
   * Whether the QR will print big enough to scan at this label's size, or `null` when the
   * template draws no QR (or the deep-link is too long to encode one at all). Drives the
   * print dialogs' "too small to scan" warning (issue #330).
   */
  readonly qrFit: QrFit | null;
  /** Text lines beneath the code, already filtered by the template's field flags. */
  readonly lines: string[];
}

/**
 * Hard cap on labels in a single sheet — keeps the generated document (and the
 * per-label encoding cost) bounded even if a very large selection is printed.
 */
export const MAX_LABELS = 500;

/*
 * Printed-label geometry, in mm. Both print stylesheets in this module are built from
 * these constants and from the sheet cell {@link sheetCellSizeMm} derives — and so is
 * {@link barcodeWidthMm}, which decides whether a barcode can print readably at all
 * (issue #331) — so the layout and the measurement of it can never disagree.
 */
/** Padding inside an A4 label cell (each side), on a cell with room to spare for it. */
const SHEET_CELL_PADDING_MM = 3;
/** Cap on a barcode's printed width in an A4 label cell (a wide cell doesn't stretch it). */
const SHEET_BARCODE_MAX_MM = 40;
/** Cap on a barcode's printed height in an A4 label cell. */
const SHEET_BARCODE_MAX_HEIGHT_MM = 14;
/** Cell height (mm) below which the A4 cell drops to the smaller die-cut type sizes. */
const SHEET_SMALL_CELL_MM = 30;
/** Gap between a label's code(s) and its text lines, in an ordinary A4 cell. */
const SHEET_CONTENT_GAP_MM = 2;
/** As {@link SHEET_CONTENT_GAP_MM}, on a cell too short to spare it. */
const SHEET_SMALL_CONTENT_GAP_MM = 1;
/** Gap between a die-cut label's code(s) and its text lines. */
const DIE_CUT_CONTENT_GAP_MM = 1;
/** Cap on a barcode's printed height on a die-cut label. */
const DIE_CUT_BARCODE_MAX_HEIGHT_MM = 12;
/** Padding between a die-cut label's safe area and its content (each side). */
const DIE_CUT_PADDING_MM = 1.5;
/**
 * Safe area kept clear at every edge of a die-cut label (issue #337).
 *
 * A die-cut page is printed at the label's exact size, so content laid out to the very edge
 * only survives if the media lines up perfectly with the page. It doesn't: a label roll
 * drifts a fraction of a millimetre as it feeds, and the die itself is cut to a tolerance —
 * so an edge-to-edge design loses whatever the drift happens to be off the side that moved.
 *
 * 1 mm covers the drift a roll-fed thermal printer typically shows, and it is deliberately
 * modest: an inset is paid for out of the label, and the smallest sizes on offer (down to a
 * 10 mm edge) have very little to give. It is not enough to rescue a die-cut page sent to an
 * ordinary inkjet, whose unprintable margin is several millimetres wide and which scales the
 * page to its own paper regardless — the print dialogs say so instead, since nothing here can
 * detect the printer.
 */
const DIE_CUT_SAFE_AREA_MM = 1;
/**
 * Total inset from a die-cut label's physical edge to its content — the safe area plus the
 * content's own padding. The stylesheet's `padding` and {@link barcodeWidthMm}'s die-cut
 * measurement are both this, so what is measured is what prints.
 */
const DIE_CUT_CONTENT_INSET_MM = DIE_CUT_SAFE_AREA_MM + DIE_CUT_PADDING_MM;

/**
 * Lines the **name** (a label's first text line) may occupy before the rest is ellipsised.
 *
 * The on-screen preview has always clamped it; neither print document did, so a name that
 * looked tidily truncated in the dialog either inflated its A4 grid row and shoved the rest of
 * the page down, or — on a die-cut label — was hard-clipped mid-line by the label's
 * `overflow:hidden` after squeezing the QR to make room (issue #334). Both stylesheets below
 * clamp to this same count, and a guard test pins the preview's `line-clamp-*` utility to it,
 * so the approved preview and the printed label agree on layout as well as content.
 */
export const LABEL_NAME_MAX_LINES = 2;

/**
 * Declarations clamping a text line to `lines` lines with a trailing ellipsis — byte-for-byte
 * the properties Tailwind's `line-clamp-<n>` emits, so the print documents truncate exactly
 * where the preview does.
 */
function lineClampCss(lines: number): string {
  return `overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines}`;
}

/** Millimetres in one typographic point (1 pt = 1/72 in). */
const PT_MM = 25.4 / 72;

/** The type a label's text block is set in: the name line, the meta lines, and their leading. */
interface LabelType {
  /** Font size (pt) of the first (name) line. */
  readonly namePt: number;
  /** Font size (pt) of every line after it. */
  readonly metaPt: number;
  /** `line-height` multiplier both are set with. */
  readonly lineHeight: number;
}

/** Type for an ordinary A4 cell. */
const SHEET_TYPE: LabelType = { namePt: 9, metaPt: 8, lineHeight: 1.2 };
/** Type for an A4 cell shorter than {@link SHEET_SMALL_CELL_MM}. */
const SHEET_SMALL_TYPE: LabelType = { namePt: 7, metaPt: 6, lineHeight: 1.2 };
/** Type for a die-cut label. */
const DIE_CUT_TYPE: LabelType = { namePt: 7, metaPt: 6, lineHeight: 1.15 };

/** The `font-size`/`line-height` declarations one of these types emits. */
function typeCss(sizePt: number, lineHeight: number): string {
  return `font-size:${sizePt}pt;line-height:${lineHeight}`;
}

/**
 * The area a label's content is actually laid out in, and the metrics of what goes in it —
 * everything {@link qrSizeMm} needs to work out how much of a fixed-size label is left for
 * the QR once the text (and any barcode) has taken its share.
 *
 * Derived from the very constants both print stylesheets below are built from, exactly as
 * {@link barcodeWidthMm} is, so the measurement and the CSS producing it cannot drift apart.
 */
interface LabelContentBox {
  readonly widthMm: number;
  readonly heightMm: number;
  /** Gap between the flex column's children. */
  readonly gapMm: number;
  readonly type: LabelType;
  /** `max-height` the barcode is capped at. */
  readonly barcodeMaxHeightMm: number;
}

function labelContentBox(template: LabelTemplate): LabelContentBox {
  if (template.sizeMode === 'die-cut') {
    const { widthMm, heightMm } = dieCutSizeMm(template.labelWidthMm, template.labelHeightMm);
    return {
      widthMm: Math.max(0, widthMm - DIE_CUT_CONTENT_INSET_MM * 2),
      heightMm: Math.max(0, heightMm - DIE_CUT_CONTENT_INSET_MM * 2),
      gapMm: DIE_CUT_CONTENT_GAP_MM,
      type: DIE_CUT_TYPE,
      barcodeMaxHeightMm: DIE_CUT_BARCODE_MAX_HEIGHT_MM,
    };
  }
  const cell = sheetCellSizeMm(template.sheet);
  const pad = sheetCellPaddingMm(cell);
  const small = cell.heightMm < SHEET_SMALL_CELL_MM;
  return {
    widthMm: Math.max(0, cell.widthMm - pad * 2),
    heightMm: Math.max(0, cell.heightMm - pad * 2),
    gapMm: small ? SHEET_SMALL_CONTENT_GAP_MM : SHEET_CONTENT_GAP_MM,
    type: small ? SHEET_SMALL_TYPE : SHEET_TYPE,
    barcodeMaxHeightMm: sheetBarcodeMaxHeightMm(cell.heightMm),
  };
}

/** The `max-height` an A4 cell of this height gives its barcode. */
function sheetBarcodeMaxHeightMm(cellHeightMm: number): number {
  return Math.min(SHEET_BARCODE_MAX_HEIGHT_MM, cellHeightMm * 0.35);
}

/**
 * The height `lineCount` text lines claim: the name line, then the rest at the smaller meta
 * size, each at one line of its own leading.
 *
 * One line **per field**, which is the optimistic reading: a name long enough to wrap takes a
 * second line (up to {@link LABEL_NAME_MAX_LINES}) and squeezes the code further. Wrapping
 * depends on the typeface the printer resolves and on the value itself, neither of which is
 * knowable here — so the estimate is deliberately the best case, and a QR this says is too
 * small is one that certainly will be.
 */
function textBlockHeightMm(lineCount: number, type: LabelType): number {
  if (lineCount <= 0) return 0;
  return (type.namePt + type.metaPt * (lineCount - 1)) * type.lineHeight * PT_MM;
}

/** The printed height of the barcode carrying `value`, which draws at its intrinsic aspect
 * across {@link barcodeWidthMm} until the label's `max-height` cap bites. */
function barcodeHeightMm(template: LabelTemplate, value: string, box: LabelContentBox): number {
  const widthMm = barcodeWidthMm(template);
  if (widthMm <= 0) return 0;
  try {
    const svg = code128SvgSize(value, barcodeSvgOptions(template));
    return Math.min(box.barcodeMaxHeightMm, (widthMm * svg.height) / svg.width);
  } catch {
    return 0;
  }
}

/**
 * The square, in mm, a label's QR actually prints at: it is the one elastic item in the flex
 * column (`flex:1 1 auto`, drawn `height:100%;width:auto`), so it gets whatever height the
 * text and barcode leave — bounded by the content width, since it stays square.
 *
 * This is the measurement issue #330 was about: a QR's module count comes from its payload, so
 * without checking it against the size it lands at, a 30 × 15 mm label with a name line prints
 * a deep-link QR at well under the minimum readable module width and the user only finds out
 * when a phone won't read the sticker they have already stuck on a box.
 */
export function qrSizeMm(template: LabelTemplate, lineCount: number, barcodeValue: string | null): number {
  const box = labelContentBox(template);
  const barcodeMm = barcodeValue === null ? 0 : barcodeHeightMm(template, barcodeValue, box);
  // The QR, the barcode (when drawn) and each text line are the flex column's children.
  const children = 1 + (barcodeValue === null ? 0 : 1) + Math.max(0, lineCount);
  const spare =
    box.heightMm - textBlockHeightMm(lineCount, box.type) - barcodeMm - box.gapMm * (children - 1);
  return Math.max(0, Math.min(spare, box.widthMm));
}

/**
 * Padding inside one A4 label cell (each side).
 *
 * A fixed 3 mm is right on an address label and absurd on a 21 mm-tall one, where it
 * would eat a third of the height before anything is drawn — so on a small cell it
 * scales down with the cell instead. {@link barcodeWidthMm} measures against this same
 * function, so the width a barcode is judged by is the width it is actually given.
 */
function sheetCellPaddingMm(cell: { readonly widthMm: number; readonly heightMm: number }): number {
  return Math.min(SHEET_CELL_PADDING_MM, cell.heightMm / 10, cell.widthMm / 10);
}

/**
 * Truncate a label set to {@link MAX_LABELS}, keeping the first labels.
 *
 * @internal Exported for unit tests only.
 */
export function clampLabels<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_LABELS);
}

/**
 * The text lines an item label shows, in display order, per the template's flags.
 *
 * @internal Exported for unit tests only.
 */
export function itemLabelLines(item: LabelItem, template: LabelTemplate): string[] {
  const lines: string[] = [];
  if (template.showName) lines.push(item.name);
  if (template.showMpn && item.mpn && item.mpn.trim().length > 0) lines.push(`MPN: ${item.mpn}`);
  if (template.showLocation && item.locationName && item.locationName.trim().length > 0) {
    lines.push(item.locationName);
  }
  if (template.showQuantity && typeof item.quantity === 'number') {
    lines.push(`Qty: ${item.quantity}`);
  }
  return lines;
}

/**
 * A symbology-agnostic label specification: the deep-link the QR encodes, the value
 * the barcode encodes, and the text lines. Both the item adapter ({@link toLabelCells})
 * and the location adapter (`location-label.ts`) build one of these, then share
 * {@link resolveCell} so QR/barcode rendering lives in exactly one place.
 */
export interface LabelSpec {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /**
   * The meaningful value the barcode should carry if it can — an item's MPN, a
   * location's name. Blank when there is none. Too long a value for the printed label
   * is swapped for a short id by {@link fitBarcodeValue}, so a caller never has to
   * size-check it itself.
   */
  readonly barcodePreferred: string;
  readonly lines: string[];
}

/** Resolve a {@link LabelSpec} to a rendered {@link LabelCell} under a template. */
export function resolveCell(spec: LabelSpec, template: LabelTemplate): LabelCell {
  const codes = renderCodes(spec, template);
  return { id: spec.id, name: spec.name, url: spec.url, ...codes, lines: spec.lines };
}

/**
 * Render the QR and/or barcode SVGs for a label spec under a template, choosing a
 * barcode value that will actually print readably at this label's size. Both encoders
 * are guarded: an un-encodable value degrades to "no code" rather than throwing. That
 * matters most for the QR, whose payload length depends on the user-supplied "Link
 * host" — this runs inside a render-time `useMemo`, so a throw here would take the whole
 * print dialog down.
 */
function renderCodes(
  spec: LabelSpec,
  template: LabelTemplate,
): {
  qrSvg: string | null;
  barcodeSvg: string | null;
  barcodeValue: string | null;
  barcodeFit: BarcodeFit | null;
  qrFit: QrFit | null;
} {
  const qr = templateHasQr(template) ? qrSvgOrNull(spec.url) : null;
  // How big the QR prints depends on what else shares the label, so it can only be settled
  // *after* the barcode is — the calls below differ only in whether a barcode is drawn.
  const resolveQrFit = (barcodeValue: string | null): QrFit | null =>
    qr === null ? null : fitQrToSize(spec.url, qrSizeMm(template, spec.lines.length, barcodeValue));
  const none = { qrSvg: qr, barcodeSvg: null, barcodeValue: null };
  if (!templateHasBarcode(template)) return { ...none, barcodeFit: null, qrFit: resolveQrFit(null) };
  const fitted = fitBarcodeValue(spec.barcodePreferred, spec.id, barcodeWidthMm(template));
  // Too narrow to print anything readable — say so rather than draw an unscannable smear.
  if (fitted.value === null) return { ...none, barcodeFit: fitted.fit, qrFit: resolveQrFit(null) };
  try {
    const barcode = code128Svg(fitted.value, barcodeSvgOptions(template));
    return {
      qrSvg: qr,
      barcodeSvg: barcode,
      barcodeValue: fitted.value,
      barcodeFit: fitted.fit,
      qrFit: resolveQrFit(fitted.value),
    };
  } catch {
    return { ...none, barcodeFit: 'unprintable', qrFit: resolveQrFit(null) };
  }
}

/**
 * The options a label's Code 128 is rendered with. Shared with {@link code128SvgSize}, so the
 * height {@link qrSizeMm} budgets for the barcode is the height it actually draws at.
 */
function barcodeSvgOptions(template: LabelTemplate) {
  return {
    scale: 2,
    height: 48,
    margin: BARCODE_QUIET_ZONE_MODULES,
    showText: template.showText,
  };
}

/**
 * The physical size, in mm, a die-cut label actually prints at: the requested dimensions
 * clamped to the supported range. The one place that clamp is applied, so the `@page` size,
 * the width a barcode is measured against, and the print dialogs' printer notice (issue #337)
 * can only ever agree about how big the label is.
 */
export function dieCutSizeMm(
  widthMm: number,
  heightMm: number,
): { readonly widthMm: number; readonly heightMm: number } {
  return {
    widthMm: clampLabelDimension(widthMm, DEFAULT_LABEL_TEMPLATE.labelWidthMm),
    heightMm: clampLabelDimension(heightMm, DEFAULT_LABEL_TEMPLATE.labelHeightMm),
  };
}

/**
 * The width, in mm, a printed Code 128 has to fit across under `template` — what the
 * minimum-module-width floor is measured against (issue #331).
 *
 * Derived from the very constants the print stylesheets below are built from, so the
 * measurement and the CSS that produces it cannot drift apart: on an A4 sheet a barcode
 * spans its grid cell, capped at {@link SHEET_BARCODE_MAX_MM}; on a die-cut label it
 * spans the full label less its {@link DIE_CUT_CONTENT_INSET_MM} inset.
 */
export function barcodeWidthMm(template: LabelTemplate): number {
  if (template.sizeMode === 'die-cut') {
    const { widthMm } = dieCutSizeMm(template.labelWidthMm, template.labelHeightMm);
    return Math.max(0, widthMm - DIE_CUT_CONTENT_INSET_MM * 2);
  }
  const cell = sheetCellSizeMm(template.sheet);
  const inner = cell.widthMm - sheetCellPaddingMm(cell) * 2;
  return Math.max(0, Math.min(SHEET_BARCODE_MAX_MM, inner));
}

/** Resolve each (capped) item to a {@link LabelCell} under the given template. */
export function toLabelCells(
  items: readonly LabelItem[],
  baseUrl: string,
  template: LabelTemplate,
): LabelCell[] {
  return clampLabels(items).map((item) =>
    resolveCell(
      {
        id: item.id,
        name: item.name,
        url: buildItemQrUrl(item.id, baseUrl),
        // Prefer the MPN/SKU a handheld scanner would look up; `resolveCell` swaps in a
        // short id when it is too long to print readably at this label size.
        barcodePreferred: item.mpn ?? '',
        lines: itemLabelLines(item, template),
      },
      template,
    ),
  );
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** The inner HTML of one printed label cell from a resolved {@link LabelCell}. */
export function labelCellHtml(cell: LabelCell): string {
  const code =
    (cell.qrSvg ? `<div class="qr">${cell.qrSvg}</div>` : '') +
    (cell.barcodeSvg ? `<div class="bc">${cell.barcodeSvg}</div>` : '');
  const text = cell.lines
    .map((line, i) => `<span class="${i === 0 ? 'name' : 'meta'}">${escapeHtml(line)}</span>`)
    .join('');
  return `<div class="label">${code}${text}</div>`;
}

/**
 * Build a complete, self-contained printable HTML document of labels — either an A4
 * grid (`sheet` mode, tiled to the template's {@link SheetLayout}) or one physical
 * die-cut label per page (`die-cut` mode). The opener writes this into a fresh window and calls
 * `print()`; nothing here touches the DOM, so it is a pure deterministic transform.
 */
export function buildLabelSheetHtml(
  items: readonly LabelItem[],
  baseUrl: string,
  template: LabelTemplate,
): string {
  const cells = toLabelCells(items, baseUrl, template).map(labelCellHtml).join('');
  return sheetDocument(cells, template);
}

/**
 * Wrap pre-rendered label-cell HTML in the print document for the template's size mode:
 * a tiled A4 grid, or one exact-sized die-cut label per page.
 */
export function sheetDocument(cellsHtml: string, template: LabelTemplate): string {
  return template.sizeMode === 'die-cut'
    ? dieCutDocument(cellsHtml, template)
    : a4SheetDocument(cellsHtml, template.sheet);
}

/**
 * An A4 page tiling labels to a {@link SheetLayout} — the columns, rows, page margins and
 * gutters of the chosen sheet stock.
 *
 * Every cell is given the **same explicit size**, derived once by {@link sheetCellSizeMm}.
 * The row height is the part that matters: an auto-height grid sizes each row to its
 * tallest cell, so a single two-line name made its row taller and pushed every row below
 * it down the page, the misalignment compounding towards the bottom (issue #333). With a
 * fixed `grid-auto-rows` the rows land where the stock's die-cuts are, whatever any one
 * label happens to contain — which is also what lets a named sheet be targeted at all.
 *
 * A cell being a fixed size, its contents have to live within it: the code takes the
 * height the text leaves it, and anything that still will not fit is clipped rather than
 * allowed to shove the sheet out of register.
 */
function a4SheetDocument(cellsHtml: string, layout: SheetLayout): string {
  const l = normaliseSheetLayout(layout);
  const cell = sheetCellSizeMm(l);
  const pad = sheetCellPaddingMm(cell);
  const small = cell.heightMm < SHEET_SMALL_CELL_MM;
  const type = small ? SHEET_SMALL_TYPE : SHEET_TYPE;
  const barcodeHeight = sheetBarcodeMaxHeightMm(cell.heightMm);
  const mm = (value: number) => `${formatMm(value)}mm`;
  return (
    '<!doctype html>' +
    '<html lang="en-GB"><head><meta charset="utf-8">' +
    '<title>Gubbins — labels</title>' +
    '<style>' +
    `@page{size:A4;margin:${mm(l.marginTopMm)} ${mm(l.marginSideMm)}}` +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#000}' +
    `.sheet{display:grid;grid-template-columns:repeat(${l.columns},${mm(cell.widthMm)});` +
    `grid-auto-rows:${mm(cell.heightMm)};column-gap:${mm(l.columnGapMm)};row-gap:${mm(l.rowGapMm)}}` +
    '.label{display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:${mm(small ? SHEET_SMALL_CONTENT_GAP_MM : SHEET_CONTENT_GAP_MM)};padding:${mm(pad)};` +
    (l.outline ? 'border:1px solid #ddd;border-radius:2mm;' : '') +
    'overflow:hidden;break-inside:avoid;text-align:center}' +
    '.label .qr{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center}' +
    '.label .qr svg{height:100%;width:auto;max-width:100%}' +
    '.label .bc{width:100%;display:flex;justify-content:center}' +
    `.label .bc svg{width:100%;max-width:${SHEET_BARCODE_MAX_MM}mm;height:auto;max-height:${mm(barcodeHeight)}}` +
    // `flex:none` keeps the text at its own height. A fixed-height cell has to take the
    // shortfall out of something, and the code is the one thing that reads at any size —
    // left to shrink, the clamped name loses the bottom of its own line to the clip the
    // clamp brings with it, and the label reads "Item" with its descenders sliced off.
    `.name{flex:none;${typeCss(type.namePt, type.lineHeight)};word-break:break-word;` +
    `max-width:100%;font-weight:600;${lineClampCss(LABEL_NAME_MAX_LINES)}}` +
    `.meta{flex:none;${typeCss(type.metaPt, type.lineHeight)};word-break:break-word;` +
    'max-width:100%;color:#444}' +
    '</style></head>' +
    `<body><div class="sheet">${cellsHtml}</div></body></html>`
  );
}

/**
 * One exact-sized label per page for a thermal / die-cut printer. The `@page` size and
 * each `.label` match the chosen physical `labelWidthMm × labelHeightMm`; the code fills
 * the available height (staying square) and the text sits beneath it, so the same label
 * scales to whatever roll is loaded.
 *
 * Content is inset by {@link DIE_CUT_CONTENT_INSET_MM} so nothing is laid out into the
 * safe area a drifting roll needs (issue #337). Overflow is clipped at the **content** box
 * rather than the padding box, so a label with more text than fits loses the surplus at the
 * safe boundary instead of bleeding out to the physical edge; `overflow:hidden` precedes it
 * as the fallback where `overflow:clip` isn't understood.
 */
function dieCutDocument(cellsHtml: string, template: LabelTemplate): string {
  const { widthMm: w, heightMm: h } = dieCutSizeMm(template.labelWidthMm, template.labelHeightMm);
  return (
    '<!doctype html>' +
    '<html lang="en-GB"><head><meta charset="utf-8">' +
    '<title>Gubbins — labels</title>' +
    '<style>' +
    `@page{size:${w}mm ${h}mm;margin:0}` +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#000}' +
    `.label{width:${w}mm;height:${h}mm;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:${DIE_CUT_CONTENT_GAP_MM}mm;` +
    `padding:${DIE_CUT_CONTENT_INSET_MM}mm;overflow:hidden;` +
    'overflow:clip;overflow-clip-margin:content-box;text-align:center;' +
    'break-after:page;break-inside:avoid}' +
    '.label:last-child{break-after:auto}' +
    '.label .qr{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center}' +
    '.label .qr svg{height:100%;width:auto;max-width:100%}' +
    '.label .bc{width:100%}' +
    `.label .bc svg{width:100%;height:auto;max-height:${DIE_CUT_BARCODE_MAX_HEIGHT_MM}mm}` +
    // The QR is the one elastic item: a tall stack of text shrinks *it*, never itself. Without
    // this the flex default shrank a clamped name back below its own two lines, and the label's
    // `overflow:hidden` then cut it mid-line with the ellipsis clipped away as well (#334).
    '.label .name,.label .meta{flex:0 0 auto;max-width:100%}' +
    `.name{${typeCss(DIE_CUT_TYPE.namePt, DIE_CUT_TYPE.lineHeight)};word-break:break-word;` +
    `font-weight:600;${lineClampCss(LABEL_NAME_MAX_LINES)}}` +
    `.meta{${typeCss(DIE_CUT_TYPE.metaPt, DIE_CUT_TYPE.lineHeight)};word-break:break-word;color:#333}` +
    '</style></head>' +
    `<body>${cellsHtml}</body></html>`
  );
}
