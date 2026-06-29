/**
 * Batch QR label-sheet builder (spec §6 "Printable QR generation", Phase 49).
 *
 * The single-item {@link import('./components/QrCodeDialog').QrCodeDialog} prints
 * one label at a time; this seam composes a whole **printable sheet** of QR labels
 * for many items at once (the multi-select flow on the inventory list), reusing the
 * lean hand-rolled {@link qrSvg} encoder (§2.4.3 native/no-bloat) and the canonical
 * deep-link payload {@link buildItemQrUrl}.
 *
 * All logic here is pure and unit-tested: {@link buildLabelSheetHtml} returns a
 * complete, self-contained HTML document (string in → string out) that the thin
 * DOM glue merely opens in a print window. {@link toLabelCells} is shared by the
 * on-screen preview so the preview and the printed sheet can never diverge.
 */
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import { qrSvg } from '@/features/scanner/qr-code';

export interface LabelItem {
  readonly id: string;
  readonly name: string;
}

export interface LabelCell extends LabelItem {
  /** The encoded deep-link URL behind the QR. */
  readonly url: string;
  /** The rendered QR as an inline SVG string. */
  readonly svg: string;
}

/**
 * Hard cap on labels in a single sheet — keeps the generated document (and the
 * per-label QR encoding cost) bounded even if a very large selection is printed.
 */
export const MAX_LABELS = 500;

/** Truncate a label set to {@link MAX_LABELS}, keeping the first labels. */
export function clampLabels(items: readonly LabelItem[]): LabelItem[] {
  return items.slice(0, MAX_LABELS);
}

/** Resolve each (capped) item to its deep-link URL and rendered QR SVG. */
export function toLabelCells(items: readonly LabelItem[], baseUrl: string): LabelCell[] {
  return clampLabels(items).map((item) => {
    const url = buildItemQrUrl(item.id, baseUrl);
    return { ...item, url, svg: qrSvg(url, { scale: 4, margin: 2 }) };
  });
}

/**
 * Build a complete, self-contained printable HTML document of QR labels — an A4
 * grid where each label holds the item's QR and name. The opener writes this into
 * a fresh window and calls `print()`; nothing here touches the DOM, so it is a pure
 * deterministic transform.
 */
export function buildLabelSheetHtml(items: readonly LabelItem[], baseUrl: string): string {
  const cells = toLabelCells(items, baseUrl)
    .map(
      (cell) =>
        `<div class="label">${cell.svg}<span class="name">${escapeHtml(cell.name)}</span></div>`,
    )
    .join('');

  return (
    '<!doctype html>' +
    '<html lang="en-GB"><head><meta charset="utf-8">' +
    '<title>Gubbins — QR labels</title>' +
    '<style>' +
    '@page{size:A4;margin:10mm}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#000}' +
    '.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}' +
    '.label{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;' +
    'gap:2mm;padding:3mm;border:1px solid #ddd;border-radius:2mm;break-inside:avoid;text-align:center}' +
    '.label svg{width:30mm;height:30mm}' +
    '.name{font-size:9pt;line-height:1.2;word-break:break-word;max-width:34mm}' +
    '</style></head>' +
    `<body><div class="sheet">${cells}</div></body></html>`
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
