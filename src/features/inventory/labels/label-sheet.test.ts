import { describe, expect, it } from 'vitest';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import {
  MAX_LABELS,
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
    const cells = toLabelCells([{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }], BASE, template({ symbology: 'barcode' }));
    expect(cells[0]!.qrSvg).toBeNull();
    expect(cells[0]!.barcodeSvg).toContain('<svg');
    expect(cells[0]!.barcodeValue).toBe('RC0805-10K');
  });

  it('renders both codes for the both symbology', () => {
    const cells = toLabelCells([{ id: ID_A, name: 'Res', mpn: 'RC0805-10K' }], BASE, template({ symbology: 'both' }));
    expect(cells[0]!.qrSvg).toContain('<svg');
    expect(cells[0]!.barcodeSvg).toContain('<svg');
  });

  it('renders no codes for the text-only symbology', () => {
    const cells = toLabelCells([{ id: ID_A, name: 'Res' }], BASE, template({ symbology: 'none' }));
    expect(cells[0]!.qrSvg).toBeNull();
    expect(cells[0]!.barcodeSvg).toBeNull();
  });

  it('caps the set at MAX_LABELS', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 25 }, (_, i) => ({ id: ID_A, name: `Item ${i}` }));
    expect(toLabelCells(many, BASE, template())).toHaveLength(MAX_LABELS);
  });
});

describe('itemLabelLines', () => {
  const item: LabelItem = { id: ID_A, name: 'Resistor', mpn: 'RC0805', locationName: 'Drawer A', quantity: 42 };

  it('includes only the fields the template enables, in order', () => {
    expect(itemLabelLines(item, template({ showName: true, showMpn: true, showLocation: true, showQuantity: true }))).toEqual([
      'Resistor',
      'MPN: RC0805',
      'Drawer A',
      'Qty: 42',
    ]);
    expect(itemLabelLines(item, template({ showName: true, showMpn: false, showLocation: false, showQuantity: false }))).toEqual([
      'Resistor',
    ]);
  });

  it('omits a flagged field whose value is missing/blank', () => {
    const sparse: LabelItem = { id: ID_A, name: 'X', mpn: '  ', locationName: null };
    expect(itemLabelLines(sparse, template({ showMpn: true, showLocation: true, showQuantity: true }))).toEqual(['X']);
  });

  it('renders a zero quantity (0 is a real value)', () => {
    expect(itemLabelLines({ id: ID_A, name: 'X', quantity: 0 }, template({ showName: false, showQuantity: true }))).toEqual([
      'Qty: 0',
    ]);
  });
});

describe('clampLabels', () => {
  it('truncates to MAX_LABELS, keeping the first labels', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 1 }, (_, i) => ({ id: ID_A, name: `Item ${i}` }));
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
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'R', mpn: 'RC0805' }], BASE, template({ symbology: 'both' }));
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
});
