/**
 * Template-aware printable label sheet (Phase 73 "Label customisation", extends the
 * Phase-49 batch QR sheet).
 *
 * The Phase-49 sheet printed a fixed grid of QR-plus-name labels. This generalises it
 * to a {@link LabelTemplate}: the chosen symbology (QR / Code 128 barcode / both /
 * none), the selected text fields, and the columns-per-sheet. The lean hand-rolled
 * encoders are reused — {@link qrSvg} (§2.4.3 native/no-bloat) and {@link code128Svg}
 * — and the canonical deep-link payload {@link buildItemQrUrl}.
 *
 * All logic here is pure and unit-tested: {@link toLabelCells} resolves each item to a
 * {@link LabelCell} (the structured code SVGs + text lines) shared by the on-screen
 * preview AND the printed sheet, so the two can never diverge; {@link buildLabelSheetHtml}
 * returns a complete, self-contained HTML document the thin DOM glue merely prints.
 */
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import { qrSvg } from '@/features/scanner/qr-code';
import { code128Svg } from './code128';
import { labelBarcodeValue, templateHasBarcode, templateHasQr, type LabelTemplate } from './label-template';

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
  /** Text lines beneath the code, already filtered by the template's field flags. */
  readonly lines: string[];
}

/**
 * Hard cap on labels in a single sheet — keeps the generated document (and the
 * per-label encoding cost) bounded even if a very large selection is printed.
 */
export const MAX_LABELS = 500;

/** Truncate a label set to {@link MAX_LABELS}, keeping the first labels. */
export function clampLabels<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_LABELS);
}

/** The text lines an item label shows, in display order, per the template's flags. */
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
  readonly barcodeValue: string;
  readonly lines: string[];
}

/** Resolve a {@link LabelSpec} to a rendered {@link LabelCell} under a template. */
export function resolveCell(spec: LabelSpec, template: LabelTemplate): LabelCell {
  const codes = renderCodes(spec.url, spec.barcodeValue, template);
  return { id: spec.id, name: spec.name, url: spec.url, ...codes, lines: spec.lines };
}

/**
 * Render the QR and/or barcode SVGs for a deep-link + barcode value under a template.
 * Barcode encoding is guarded: an un-encodable value (it should already be sanitised
 * by {@link labelBarcodeValue}) degrades to "no barcode" rather than throwing.
 */
function renderCodes(
  url: string,
  barcodeValue: string,
  template: LabelTemplate,
): { qrSvg: string | null; barcodeSvg: string | null; barcodeValue: string | null } {
  const qr = templateHasQr(template) ? qrSvg(url, { scale: 4, margin: 2 }) : null;
  let barcode: string | null = null;
  let value: string | null = null;
  if (templateHasBarcode(template) && barcodeValue.length > 0) {
    try {
      barcode = code128Svg(barcodeValue, { scale: 2, height: 48, margin: 8, showText: template.showText });
      value = barcodeValue;
    } catch {
      barcode = null;
      value = null;
    }
  }
  return { qrSvg: qr, barcodeSvg: barcode, barcodeValue: value };
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
        barcodeValue: labelBarcodeValue(item),
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
 * Build a complete, self-contained printable HTML document of labels — an A4 grid
 * (the template's `columns` across) where each label holds the chosen code(s) and
 * text. The opener writes this into a fresh window and calls `print()`; nothing here
 * touches the DOM, so it is a pure deterministic transform.
 */
export function buildLabelSheetHtml(
  items: readonly LabelItem[],
  baseUrl: string,
  template: LabelTemplate,
): string {
  const cells = toLabelCells(items, baseUrl, template).map(labelCellHtml).join('');
  return sheetDocument(cells, template.columns);
}

/** Wrap pre-rendered label-cell HTML in the shared A4 print document for `columns`. */
export function sheetDocument(cellsHtml: string, columns: number): string {
  return (
    '<!doctype html>' +
    '<html lang="en-GB"><head><meta charset="utf-8">' +
    '<title>Gubbins — labels</title>' +
    '<style>' +
    '@page{size:A4;margin:10mm}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#000}' +
    `.sheet{display:grid;grid-template-columns:repeat(${columns},1fr);gap:6mm}` +
    '.label{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;' +
    'gap:2mm;padding:3mm;border:1px solid #ddd;border-radius:2mm;break-inside:avoid;text-align:center}' +
    '.label .qr svg{width:30mm;height:30mm}' +
    '.label .bc svg{max-width:40mm;height:14mm}' +
    '.name{font-size:9pt;line-height:1.2;word-break:break-word;max-width:40mm;font-weight:600}' +
    '.meta{font-size:8pt;line-height:1.2;word-break:break-word;max-width:40mm;color:#444}' +
    '</style></head>' +
    `<body><div class="sheet">${cellsHtml}</div></body></html>`
  );
}
