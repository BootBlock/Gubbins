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
import { code128Svg } from './code128';
import {
  BARCODE_QUIET_ZONE_MODULES,
  DEFAULT_LABEL_TEMPLATE,
  clampLabelDimension,
  fitBarcodeValue,
  formatMm,
  normaliseSheetLayout,
  sheetCellSizeMm,
  templateHasBarcode,
  templateHasQr,
  type BarcodeFit,
  type LabelTemplate,
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
/** Padding inside a die-cut label (each side). */
const DIE_CUT_PADDING_MM = 1.5;

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
} {
  const qr = templateHasQr(template) ? qrSvgOrNull(spec.url, { scale: 4, margin: 2 }) : null;
  const none = { qrSvg: qr, barcodeSvg: null, barcodeValue: null };
  if (!templateHasBarcode(template)) return { ...none, barcodeFit: null };
  const fitted = fitBarcodeValue(spec.barcodePreferred, spec.id, barcodeWidthMm(template));
  // Too narrow to print anything readable — say so rather than draw an unscannable smear.
  if (fitted.value === null) return { ...none, barcodeFit: fitted.fit };
  try {
    const barcode = code128Svg(fitted.value, {
      scale: 2,
      height: 48,
      margin: BARCODE_QUIET_ZONE_MODULES,
      showText: template.showText,
    });
    return { qrSvg: qr, barcodeSvg: barcode, barcodeValue: fitted.value, barcodeFit: fitted.fit };
  } catch {
    return { ...none, barcodeFit: 'unprintable' };
  }
}

/**
 * The width, in mm, a printed Code 128 has to fit across under `template` — what the
 * minimum-module-width floor is measured against (issue #331).
 *
 * Derived from the very constants the print stylesheets below are built from, so the
 * measurement and the CSS that produces it cannot drift apart: on an A4 sheet a barcode
 * spans its grid cell, capped at {@link SHEET_BARCODE_MAX_MM}; on a die-cut label it
 * spans the full label less its padding.
 */
export function barcodeWidthMm(template: LabelTemplate): number {
  if (template.sizeMode === 'die-cut') {
    const width = clampLabelDimension(template.labelWidthMm, DEFAULT_LABEL_TEMPLATE.labelWidthMm);
    return Math.max(0, width - DIE_CUT_PADDING_MM * 2);
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
  const barcodeHeight = Math.min(SHEET_BARCODE_MAX_HEIGHT_MM, cell.heightMm * 0.35);
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
    `gap:${small ? '1mm' : '2mm'};padding:${mm(pad)};` +
    (l.outline ? 'border:1px solid #ddd;border-radius:2mm;' : '') +
    'overflow:hidden;break-inside:avoid;text-align:center}' +
    '.label .qr{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center}' +
    '.label .qr svg{height:100%;width:auto;max-width:100%}' +
    '.label .bc{width:100%;display:flex;justify-content:center}' +
    `.label .bc svg{width:100%;max-width:${SHEET_BARCODE_MAX_MM}mm;height:auto;max-height:${mm(barcodeHeight)}}` +
    `.name{font-size:${small ? '7pt' : '9pt'};line-height:1.2;word-break:break-word;max-width:100%;font-weight:600}` +
    `.meta{font-size:${small ? '6pt' : '8pt'};line-height:1.2;word-break:break-word;max-width:100%;color:#444}` +
    '</style></head>' +
    `<body><div class="sheet">${cellsHtml}</div></body></html>`
  );
}

/**
 * One exact-sized label per page for a thermal / die-cut printer. The `@page` size and
 * each `.label` match the chosen physical `labelWidthMm × labelHeightMm`; the code fills
 * the available height (staying square) and the text sits beneath it, so the same label
 * scales to whatever roll is loaded.
 */
function dieCutDocument(cellsHtml: string, template: LabelTemplate): string {
  const w = clampLabelDimension(template.labelWidthMm, DEFAULT_LABEL_TEMPLATE.labelWidthMm);
  const h = clampLabelDimension(template.labelHeightMm, DEFAULT_LABEL_TEMPLATE.labelHeightMm);
  return (
    '<!doctype html>' +
    '<html lang="en-GB"><head><meta charset="utf-8">' +
    '<title>Gubbins — labels</title>' +
    '<style>' +
    `@page{size:${w}mm ${h}mm;margin:0}` +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#000}' +
    `.label{width:${w}mm;height:${h}mm;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:1mm;padding:${DIE_CUT_PADDING_MM}mm;overflow:hidden;text-align:center;` +
    'break-after:page;break-inside:avoid}' +
    '.label:last-child{break-after:auto}' +
    '.label .qr{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center}' +
    '.label .qr svg{height:100%;width:auto;max-width:100%}' +
    '.label .bc{width:100%}' +
    '.label .bc svg{width:100%;height:auto;max-height:12mm}' +
    '.name{font-size:7pt;line-height:1.15;word-break:break-word;font-weight:600}' +
    '.meta{font-size:6pt;line-height:1.15;word-break:break-word;color:#333}' +
    '</style></head>' +
    `<body>${cellsHtml}</body></html>`
  );
}
