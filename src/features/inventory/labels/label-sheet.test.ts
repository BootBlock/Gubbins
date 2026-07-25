import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { repoPath } from '@/test/repo-path';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import {
  LABEL_NAME_MAX_LINES,
  MAX_LABELS,
  barcodeWidthMm,
  buildLabelSheetHtml,
  clampLabels,
  itemLabelLines,
  qrSizeMm,
  toLabelCells,
  type LabelItem,
} from './label-sheet';
import {
  MIN_QR_MODULE_MM,
  PLAIN_PAPER_SHEET_LAYOUT,
  SHEET_STOCK_PRESETS,
  DEFAULT_LABEL_TEMPLATE,
  type LabelTemplate,
  type SheetLayout,
} from './label-template';

const BASE = 'https://example.test/Gubbins/';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
/** An id whose short form carries letters, so Code 128 cannot compress it. */
const ID_C = 'a1b2c3d4-3333-4333-8333-333333333333';

const template = (over: Partial<LabelTemplate> = {}): LabelTemplate => ({
  ...DEFAULT_LABEL_TEMPLATE,
  ...over,
});

/** The default (plain-paper) A4 tiling with a field or two changed. */
const sheet = (over: Partial<SheetLayout> = {}): SheetLayout => ({
  ...PLAIN_PAPER_SHEET_LAYOUT,
  ...over,
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('barcodeWidthMm', () => {
  it('caps a roomy A4 cell at the stylesheet max-width', () => {
    expect(barcodeWidthMm(template({ sheet: sheet({ columns: 1 }) }))).toBe(40);
    expect(barcodeWidthMm(template({ sheet: sheet({ columns: 3 }) }))).toBe(40);
  });

  it('narrows to the grid cell once the columns squeeze it below that cap', () => {
    // A4 (210mm) less 2 × 10mm page margin = 190mm; less 3 × 5mm gaps, over 4 columns,
    // less the cell's 2 × 3mm padding.
    expect(barcodeWidthMm(template({ sheet: sheet({ columns: 4 }) }))).toBe(37.75);
  });

  it('measures a named stock at the size that stock actually is (issue #333)', () => {
    // 21-per-sheet address labels are 63.5mm wide; the cell's padding scales with the
    // cell, so the width judged here is the width the barcode is really given.
    const stock = SHEET_STOCK_PRESETS.find((p) => p.id === 'a4-21up')!;
    expect(barcodeWidthMm(template({ sheet: stock.layout }))).toBe(40);
    // The smallest stock is narrower than the cap, so it is the label that decides.
    const tiny = SHEET_STOCK_PRESETS.find((p) => p.id === 'a4-65up')!;
    expect(barcodeWidthMm(template({ sheet: tiny.layout }))).toBeCloseTo(33.86, 2);
  });

  it('is the die-cut label less its safe area and padding', () => {
    const dieCut = (widthMm: number) =>
      barcodeWidthMm(template({ sizeMode: 'die-cut', labelWidthMm: widthMm, labelHeightMm: 30 }));
    // 2 × (1mm safe area + 1.5mm padding) comes off the physical width (issue #337).
    expect(dieCut(40)).toBe(35);
    expect(dieCut(100)).toBe(95);
  });
});

describe('toLabelCells', () => {
  it('produces one cell per item, in order, with the deep-link URL and a QR SVG (default template)', () => {
    const items: LabelItem[] = [
      { id: ID_A, name: 'Resistor 10k' },
      { id: ID_B, name: 'ESP32 board' },
    ];
    const cells = toLabelCells(items, BASE, template());
    expect(cells.map((c) => c.id)).toEqual([ID_A, ID_B]);
    expect(cells[0]!.url).toBe(buildItemQrUrl(ID_A, BASE));
    expect(cells[0]!.qrSvg).toContain('<svg');
    expect(cells[0]!.barcodeSvg).toBeNull();
    expect(cells[0]!.lines).toEqual(['Resistor 10k']);
  });

  it('renders a barcode and no QR for the barcode-only symbology', () => {
    const cells = toLabelCells(
      [{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }],
      BASE,
      template({ symbology: 'barcode' }),
    );
    expect(cells[0]!.qrSvg).toBeNull();
    expect(cells[0]!.barcodeSvg).toContain('<svg');
    expect(cells[0]!.barcodeValue).toBe('RC0805-10K');
  });

  it('renders both codes for the both symbology', () => {
    const cells = toLabelCells(
      [{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }],
      BASE,
      template({ symbology: 'both' }),
    );
    expect(cells[0]!.qrSvg).toContain('<svg');
    expect(cells[0]!.barcodeSvg).toContain('<svg');
  });

  it('renders no codes for the text-only symbology', () => {
    const cells = toLabelCells([{ id: ID_A, name: 'Res' }], BASE, template({ symbology: 'none' }));
    expect(cells[0]!.qrSvg).toBeNull();
    expect(cells[0]!.barcodeSvg).toBeNull();
  });

  it('falls back to a short id when the MPN is too long to print readably (issue #331)', () => {
    const cells = toLabelCells(
      [{ id: ID_A, name: 'Res', mpn: 'RC0805-10K-0402-VERY-LONG-PART-NUMBER' }],
      BASE,
      template({ symbology: 'barcode' }),
    );
    expect(cells[0]!.barcodeValue).toBe('11111111');
    expect(cells[0]!.barcodeFit).toBe('shortened');
    expect(cells[0]!.barcodeSvg).toContain('<svg');
  });

  it('prints no barcode on a label too narrow for even the short id', () => {
    const cells = toLabelCells(
      [{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }],
      BASE,
      template({ symbology: 'barcode', sizeMode: 'die-cut', labelWidthMm: 20, labelHeightMm: 15 }),
    );
    expect(cells[0]!.barcodeSvg).toBeNull();
    expect(cells[0]!.barcodeValue).toBeNull();
    expect(cells[0]!.barcodeFit).toBe('unprintable');
  });

  it('treats every label on a too-narrow size alike, whatever its id (issue #331)', () => {
    // The 30 x 15 mm preset leaves 25 mm — under the width a fallback code needs. `ID_A`'s
    // short id is all digits and `ID_C`'s is not; measured as encoded, Code Set C would let
    // the first through and not the second. The sheet must not be arbitrary like that.
    const cells = toLabelCells(
      [
        { id: ID_A, name: 'Digits', mpn: 'RC0805-10K' },
        { id: ID_C, name: 'Hex', mpn: 'RC0805-10K' },
        { id: ID_A, name: 'No MPN' },
      ],
      BASE,
      template({ symbology: 'barcode', sizeMode: 'die-cut', labelWidthMm: 30, labelHeightMm: 15 }),
    );
    expect(cells.map((c) => c.barcodeFit)).toEqual(['unprintable', 'unprintable', 'unprintable']);
    expect(cells.every((c) => c.barcodeSvg === null)).toBe(true);
  });

  it('reports no barcode fit at all when the template draws no barcode', () => {
    const cells = toLabelCells([{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }], BASE, template());
    expect(cells[0]!.barcodeFit).toBeNull();
  });

  it('caps the set at MAX_LABELS', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 25 }, (_, i) => ({
      id: ID_A,
      name: `Item ${i}`,
    }));
    expect(toLabelCells(many, BASE, template())).toHaveLength(MAX_LABELS);
  });
});

describe('itemLabelLines', () => {
  const item: LabelItem = {
    id: ID_A,
    name: 'Resistor',
    mpn: 'RC0805',
    locationName: 'Drawer A',
    quantity: 42,
  };

  it('includes only the fields the template enables, in order', () => {
    expect(
      itemLabelLines(
        item,
        template({ showName: true, showMpn: true, showLocation: true, showQuantity: true }),
      ),
    ).toEqual(['Resistor', 'MPN: RC0805', 'Drawer A', 'Qty: 42']);
    expect(
      itemLabelLines(
        item,
        template({ showName: true, showMpn: false, showLocation: false, showQuantity: false }),
      ),
    ).toEqual(['Resistor']);
  });

  it('omits a flagged field whose value is missing/blank', () => {
    const sparse: LabelItem = { id: ID_A, name: 'X', mpn: '  ', locationName: null };
    expect(
      itemLabelLines(sparse, template({ showMpn: true, showLocation: true, showQuantity: true })),
    ).toEqual(['X']);
  });

  it('renders a zero quantity (0 is a real value)', () => {
    expect(
      itemLabelLines({ id: ID_A, name: 'X', quantity: 0 }, template({ showName: false, showQuantity: true })),
    ).toEqual(['Qty: 0']);
  });
});

describe('clampLabels', () => {
  it('truncates to MAX_LABELS, keeping the first labels', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 1 }, (_, i) => ({
      id: ID_A,
      name: `Item ${i}`,
    }));
    const clamped = clampLabels(many);
    expect(clamped).toHaveLength(MAX_LABELS);
    expect(clamped[0]!.name).toBe('Item 0');
  });
});

describe('buildLabelSheetHtml', () => {
  it('returns a complete, self-contained printable document with the template column count', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Resistor 10k' }],
      BASE,
      template({ sheet: sheet({ columns: 4 }) }),
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@page');
    expect(html).toContain('A4');
    // (210 - 2 × 10 margin - 3 × 5 gutter) / 4.
    expect(html).toContain('grid-template-columns:repeat(4,43.75mm)');
    expect(html).toContain('break-inside');
  });

  it('gives every row the same fixed height, so a tall label cannot shift the rest (issue #333)', () => {
    // A two-line name used to make its row taller than the others and push every row below
    // it down the page. An explicit `grid-auto-rows` is what stops that: the row is the
    // stock's row whatever the label carries.
    const html = buildLabelSheetHtml(
      [
        { id: ID_A, name: 'A name long enough to wrap onto a second printed line' },
        { id: ID_B, name: 'Short' },
      ],
      BASE,
      template(),
    );
    // (297 - 2 × 10 margin - 5 × 5 gutter) / 6.
    expect(html).toContain('grid-auto-rows:42mm');
    expect(html).not.toContain('1fr');
    // A fixed cell only holds if its contents are kept inside it.
    expect(html).toContain('overflow:hidden');
  });

  it('tiles a named sheet stock to its own margins and gutters (issue #333)', () => {
    const stock = SHEET_STOCK_PRESETS.find((p) => p.id === 'a4-21up')!;
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Resistor 10k' }],
      BASE,
      template({ sheet: stock.layout }),
    );
    expect(html).toContain('@page{size:A4;margin:15.15mm 7.25mm}');
    expect(html).toContain('grid-template-columns:repeat(3,63.5mm)');
    expect(html).toContain('grid-auto-rows:38.1mm');
    expect(html).toContain('column-gap:2.5mm;row-gap:0mm');
    // Pre-cut stickers are already cut — an outline would print a box inside each one.
    expect(html).not.toContain('border:1px solid');
  });

  it('holds the text at its own height, leaving the code to absorb a fixed cell (issue #333)', () => {
    // The name is clamped *and* clips what the clamp cuts (issue #334). In a cell of fixed
    // height something must give up the shortfall, and if it were the text the clip would
    // take the bottom off the name's own line — so the code, which reads at any size, is
    // the only flexible thing in the cell.
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'X' }], BASE, template());
    expect(html).toContain('.name{flex:none');
    expect(html).toContain('.meta{flex:none');
    expect(html).toContain('.label .qr{flex:1 1 auto');
  });

  it('draws a cut guide on plain paper, where nothing else marks the label out', () => {
    expect(buildLabelSheetHtml([{ id: ID_A, name: 'X' }], BASE, template())).toContain('border:1px solid');
  });

  it('renders one QR SVG and the item name per label by default', () => {
    const html = buildLabelSheetHtml(
      [
        { id: ID_A, name: 'Resistor 10k' },
        { id: ID_B, name: 'ESP32 board' },
      ],
      BASE,
      template(),
    );
    expect(countOccurrences(html, '<svg')).toBe(2);
    expect(html).toContain('Resistor 10k');
    expect(html).toContain('ESP32 board');
  });

  it('renders two SVGs per label for the both symbology', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'R', mpn: 'RC0805' }],
      BASE,
      template({ symbology: 'both' }),
    );
    expect(countOccurrences(html, '<svg')).toBe(2);
  });

  it('escapes HTML-special characters in item names', () => {
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'Cap <100µF> & "big"' }], BASE, template());
    expect(html).toContain('Cap &lt;100µF&gt; &amp; &quot;big&quot;');
    expect(html).not.toContain('<100µF>');
  });

  it('produces a valid document with no label cells for an empty set', () => {
    const html = buildLabelSheetHtml([], BASE, template());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(countOccurrences(html, '<svg')).toBe(0);
  });

  it('honours the MAX_LABELS cap', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 10 }, () => ({ id: ID_A, name: 'Bulk' }));
    const html = buildLabelSheetHtml(many, BASE, template());
    expect(countOccurrences(html, '<svg')).toBe(MAX_LABELS);
  });

  it('emits an exact-sized single-label-per-page document in die-cut mode', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Resistor 10k' }],
      BASE,
      template({ sizeMode: 'die-cut', labelWidthMm: 40, labelHeightMm: 30 }),
    );
    expect(html).toContain('@page{size:40mm 30mm;margin:0}');
    expect(html).toContain('width:40mm;height:30mm');
    expect(html).toContain('break-after:page');
    // A die-cut sheet is not the tiled A4 grid.
    expect(html).not.toContain('@page{size:A4');
    expect(html).not.toContain('grid-template-columns');
    expect(html).toContain('Resistor 10k');
  });

  it('clamps out-of-range die-cut dimensions in the rendered @page size', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'X' }],
      BASE,
      template({ sizeMode: 'die-cut', labelWidthMm: 4, labelHeightMm: 9999 }),
    );
    expect(html).toContain('@page{size:10mm 300mm;margin:0}');
  });

  it('insets die-cut content behind a safe area and clips overflow at it (issue #337)', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Resistor 10k' }],
      BASE,
      template({ sizeMode: 'die-cut', labelWidthMm: 40, labelHeightMm: 30 }),
    );
    // The page is still the label's exact size — the tolerance is taken out of the content,
    // never out of the page, or the printer would receive the wrong media size.
    expect(html).toContain('@page{size:40mm 30mm;margin:0}');
    expect(html).toContain('width:40mm;height:30mm');
    // 1mm safe area + 1.5mm padding, so nothing is laid out within 1mm of the die edge.
    expect(html).toContain('padding:2.5mm');
    // Surplus content is cut at the safe boundary rather than bleeding to the physical edge.
    expect(html).toContain('overflow-clip-margin:content-box');
  });

  it('keeps the A4 sheet page margin and cell padding unchanged', () => {
    // The safe-area inset is a die-cut concern: the default A4 layout already carries a
    // 10mm margin on every edge, wider than any printer's unprintable edge.
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'X' }], BASE, template());
    expect(html).toContain('@page{size:A4;margin:10mm 10mm}');
    expect(html).toContain('padding:3mm');
    expect(html).not.toContain('overflow-clip-margin');
  });
});

/**
 * The printed name obeys the same line clamp the dialog preview shows (issue #334).
 *
 * The preview clamped the name and neither print document did, so an over-long name that
 * looked truncated on screen printed in full — inflating an A4 grid row, or being hard-clipped
 * mid-line by a die-cut label's `overflow:hidden` after squeezing the QR out of the way. These
 * pin the clamp into both stylesheets and hold the preview's Tailwind utility to the same count,
 * so neither side can drift back.
 */
describe('the printed name clamp', () => {
  const CLAMP = `-webkit-line-clamp:${LABEL_NAME_MAX_LINES}`;

  it('clamps the name — and only the name — in the A4 sheet document', () => {
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'Resistor 10k' }], BASE, template());
    expect(html).toContain(
      `font-weight:600;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;${CLAMP}}`,
    );
    // The meta lines wrap freely in the preview, so they must here too.
    expect(countOccurrences(html, CLAMP)).toBe(1);
  });

  it('clamps the name in the die-cut document, where the label would otherwise clip it mid-line', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Resistor 10k' }],
      BASE,
      template({ sizeMode: 'die-cut', labelWidthMm: 40, labelHeightMm: 30 }),
    );
    expect(html).toContain(
      `font-weight:600;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;${CLAMP}}`,
    );
    expect(countOccurrences(html, CLAMP)).toBe(1);
    // The clamp alone is not enough here: the label is a fixed-height flex column, so without
    // this the name shrank below its own two lines and lost the ellipsis to `overflow:hidden`.
    expect(html).toContain('.label .name,.label .meta{flex:0 0 auto');
    expect(html).toContain('.label .qr{flex:1 1 auto');
  });

  it('matches the line count the on-screen preview clamps to', () => {
    const preview = readFileSync(
      repoPath(import.meta.dirname, 'src', 'features', 'inventory', 'components', 'LabelCellPreview.tsx'),
      'utf8',
    );
    // Tailwind needs the literal utility, so the preview cannot build it from the constant —
    // this is what keeps the two honest.
    expect(preview).toContain(`line-clamp-${LABEL_NAME_MAX_LINES}`);
    expect(preview).not.toMatch(new RegExp(`line-clamp-(?!${LABEL_NAME_MAX_LINES}\\b)\\d`));
  });
});

describe('printed QR size (issue #330)', () => {
  /** The deep-link's symbol (37 modules) plus its mandatory 4-module quiet zone either side. */
  const TOTAL_MODULES = 37 + 8;
  const item: LabelItem = { id: ID_A, name: 'Widget', mpn: 'MPN-1', locationName: 'Shelf B', quantity: 4 };

  /** The module width, in mm, the one cell this template produces would print at. */
  const moduleMm = (t: LabelTemplate): number =>
    qrSizeMm(
      t,
      toLabelCells([item], BASE, t)[0].lines.length,
      toLabelCells([item], BASE, t)[0].barcodeValue,
    ) / TOTAL_MODULES;

  const fit = (t: LabelTemplate) => toLabelCells([item], BASE, t)[0].qrFit;

  it('flags the small die-cut preset the issue was raised about', () => {
    // 30 × 15 mm with a name line: ~6 mm of height for 45 modules. The user sticks these on
    // boxes and finds out later that phones will not read them.
    const t = template({ sizeMode: 'die-cut', labelWidthMm: 30, labelHeightMm: 15 });
    expect(moduleMm(t)).toBeLessThan(MIN_QR_MODULE_MM);
    expect(fit(t)).toBe('tooSmall');
  });

  it('accepts the sizes with room for a readable code', () => {
    // The default A4 tiling (60 × 42 mm cells) and a square die-cut label.
    expect(fit(template())).toBe('ok');
    expect(fit(template({ sizeMode: 'die-cut', labelWidthMm: 50, labelHeightMm: 50 }))).toBe('ok');
    // 40 × 30 with nothing but the code — the whole label is the QR's.
    const bare = template({
      sizeMode: 'die-cut',
      labelWidthMm: 40,
      labelHeightMm: 30,
      showName: false,
    });
    expect(moduleMm(bare)).toBeGreaterThan(MIN_QR_MODULE_MM);
    expect(fit(bare)).toBe('ok');
  });

  it('shrinks the QR as text lines and a barcode take the label’s height', () => {
    const base = { sizeMode: 'die-cut', labelWidthMm: 40, labelHeightMm: 30 } as const;
    const nameOnly = template(base);
    const everything = template({ ...base, showMpn: true, showLocation: true, showQuantity: true });
    const withBarcode = template({ ...base, symbology: 'both' });
    expect(moduleMm(everything)).toBeLessThan(moduleMm(nameOnly));
    expect(moduleMm(withBarcode)).toBeLessThan(moduleMm(nameOnly));
    // Four text lines plus their gaps leave a 40 × 20 label nothing worth printing.
    expect(
      fit(template({ ...base, labelHeightMm: 20, showMpn: true, showLocation: true, showQuantity: true })),
    ).toBe('tooSmall');
  });

  it('reports no fit at all where there is no QR to measure', () => {
    expect(toLabelCells([item], BASE, template({ symbology: 'barcode' }))[0].qrFit).toBeNull();
    expect(toLabelCells([item], BASE, template({ symbology: 'none' }))[0].qrFit).toBeNull();
    // A deep-link past the encoder's ceiling leaves the label without a QR — already surfaced
    // as "this link is too long", so it is not also reported as too small.
    const longBase = `https://${'sub.'.repeat(50)}example.test/Gubbins/`;
    const cell = toLabelCells([item], longBase, template())[0];
    expect(cell.qrSvg).toBeNull();
    expect(cell.qrFit).toBeNull();
  });

  it('measures the label the stylesheet actually lays out', () => {
    // The die-cut safe area + padding is inset from both edges, so the QR can never be wider
    // than the content box — the same inset `barcodeWidthMm` measures against.
    const t = template({ sizeMode: 'die-cut', labelWidthMm: 20, labelHeightMm: 100, showName: false });
    expect(qrSizeMm(t, 0, null)).toBeCloseTo(20 - 2.5 * 2, 10);
  });
});
