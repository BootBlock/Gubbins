import { describe, expect, it } from 'vitest';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import {
  MAX_LABELS,
  buildLabelSheetHtml,
  clampLabels,
  toLabelCells,
  type LabelItem,
} from './qr-label-sheet';

const BASE = 'https://example.test/Gubbins/';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('toLabelCells', () => {
  it('produces one cell per item, in order, with the deep-link URL and a QR SVG', () => {
    const items: LabelItem[] = [
      { id: ID_A, name: 'Resistor 10k' },
      { id: ID_B, name: 'ESP32 board' },
    ];
    const cells = toLabelCells(items, BASE);
    expect(cells.map((c) => c.id)).toEqual([ID_A, ID_B]);
    expect(cells[0]!.name).toBe('Resistor 10k');
    expect(cells[0]!.url).toBe(buildItemQrUrl(ID_A, BASE));
    expect(cells[1]!.url).toBe(buildItemQrUrl(ID_B, BASE));
    expect(cells[0]!.svg).toContain('<svg');
    expect(cells[1]!.svg).toContain('<svg');
  });

  it('caps the set at MAX_LABELS', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 25 }, (_, i) => ({
      id: ID_A,
      name: `Item ${i}`,
    }));
    expect(toLabelCells(many, BASE)).toHaveLength(MAX_LABELS);
  });
});

describe('clampLabels', () => {
  it('returns the list unchanged when within the cap', () => {
    const items: LabelItem[] = [{ id: ID_A, name: 'A' }];
    expect(clampLabels(items)).toEqual(items);
  });

  it('truncates to MAX_LABELS, keeping the first labels', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 1 }, (_, i) => ({
      id: ID_A,
      name: `Item ${i}`,
    }));
    const clamped = clampLabels(many);
    expect(clamped).toHaveLength(MAX_LABELS);
    expect(clamped[0]!.name).toBe('Item 0');
    expect(clamped[MAX_LABELS - 1]!.name).toBe(`Item ${MAX_LABELS - 1}`);
  });
});

describe('buildLabelSheetHtml', () => {
  it('returns a complete, self-contained printable document', () => {
    const html = buildLabelSheetHtml([{ id: ID_A, name: 'Resistor 10k' }], BASE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    // A4 page styling so the sheet prints cleanly.
    expect(html).toContain('@page');
    expect(html).toContain('A4');
    // Grid so labels lay out in rows/columns and break cleanly across pages.
    expect(html).toContain('grid-template-columns');
    expect(html).toContain('break-inside');
  });

  it('renders one QR SVG and the item name per label', () => {
    const html = buildLabelSheetHtml(
      [
        { id: ID_A, name: 'Resistor 10k' },
        { id: ID_B, name: 'ESP32 board' },
      ],
      BASE,
    );
    expect(countOccurrences(html, '<svg')).toBe(2);
    expect(html).toContain('Resistor 10k');
    expect(html).toContain('ESP32 board');
  });

  it('escapes HTML-special characters in item names', () => {
    const html = buildLabelSheetHtml(
      [{ id: ID_A, name: 'Cap <100µF> & "big"' }],
      BASE,
    );
    expect(html).toContain('Cap &lt;100µF&gt; &amp; &quot;big&quot;');
    expect(html).not.toContain('<100µF>');
  });

  it('produces a valid document with no label cells for an empty set', () => {
    const html = buildLabelSheetHtml([], BASE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(countOccurrences(html, '<svg')).toBe(0);
  });

  it('honours the MAX_LABELS cap', () => {
    const many: LabelItem[] = Array.from({ length: MAX_LABELS + 10 }, () => ({
      id: ID_A,
      name: 'Bulk',
    }));
    const html = buildLabelSheetHtml(many, BASE);
    expect(countOccurrences(html, '<svg')).toBe(MAX_LABELS);
  });
});
