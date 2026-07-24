import { describe, expect, it } from 'vitest';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import {
  MAX_LABELS,
  barcodeWidthMm,
  buildLabelSheetHtml,
  clampLabels,
  itemLabelLines,
  toLabelCells,
  type LabelItem,
} from './label-sheet';
import { DEFAULT_LABEL_TEMPLATE, type LabelTemplate } from './label-template';

const BASE = 'https://example.test/Gubbins/';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const template = (over: Partial<LabelTemplate> = {}): LabelTemplate => ({
  ...DEFAULT_LABEL_TEMPLATE,
  ...over,
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('barcodeWidthMm', () => {
  it('caps a roomy A4 cell at the stylesheet max-width', () => {
    expect(barcodeWidthMm(template({ columns: 1 }))).toBe(40);
    expect(barcodeWidthMm(template({ columns: 3 }))).toBe(40);
  });

  it('narrows to the grid cell once the columns squeeze it below that cap', () => {
    // A4 (210mm) less 2 × 10mm page margin = 190mm; less 3 × 6mm gaps, over 4 columns,
    // less the cell's 2 × 3mm padding.
    expect(barcodeWidthMm(template({ columns: 4 }))).toBe(37);
  });

  it('is the die-cut label less its padding', () => {
    const dieCut = (widthMm: number) =>
      barcodeWidthMm(template({ sizeMode: 'die-cut', labelWidthMm: widthMm, labelHeightMm: 30 }));
    expect(dieCut(40)).toBe(37);
    expect(dieCut(100)).toBe(97);
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
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'Resistor 10k' }], BASE, template({ columns: 4 }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@page');
    expect(html).toContain('A4');
    expect(html).toContain('grid-template-columns:repeat(4,1fr)');
    expect(html).toContain('break-inside');
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
});
