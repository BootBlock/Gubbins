import { describe, expect, it } from 'vitest';
import {
  MAX_LOCATION_LABEL_COPIES,
  buildLocationLabelHtml,
  clampCopies,
  locationLabelLines,
  locationPath,
  toLocationLabelCell,
  type LocationPathNode,
} from './location-label';
import { DEFAULT_LABEL_TEMPLATE, type LabelTemplate } from './label-template';
import { buildLocationQrUrl } from '@/features/scanner/scan-payload';

const BASE = 'https://example.test/Gubbins/';
const ROOT = '00000000-0000-4000-8000-000000000010';
const SHELF = '00000000-0000-4000-8000-000000000011';
const BIN = '00000000-0000-4000-8000-000000000012';

const NODES: LocationPathNode[] = [
  { id: ROOT, name: 'Workshop', parentId: null },
  { id: SHELF, name: 'Shelf B', parentId: ROOT },
  { id: BIN, name: 'Bin 3', parentId: SHELF },
];

const template = (over: Partial<LabelTemplate> = {}): LabelTemplate => ({
  ...DEFAULT_LABEL_TEMPLATE,
  ...over,
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('locationPath', () => {
  it('joins the ancestor chain root-first, excluding the node itself', () => {
    expect(locationPath(BIN, NODES)).toBe('Workshop / Shelf B');
    expect(locationPath(SHELF, NODES)).toBe('Workshop');
    expect(locationPath(ROOT, NODES)).toBe('');
  });

  it('is cycle-safe', () => {
    const cyclic: LocationPathNode[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    // Stops at the first repeat rather than looping forever.
    expect(locationPath('a', cyclic)).toBe('B');
  });
});

describe('clampCopies', () => {
  it('clamps to 1..max and rounds, defaulting on garbage', () => {
    expect(clampCopies(0)).toBe(1);
    expect(clampCopies(999)).toBe(MAX_LOCATION_LABEL_COPIES);
    expect(clampCopies(2.6)).toBe(3);
    expect(clampCopies('x')).toBe(1);
  });
});

describe('locationLabelLines', () => {
  it('shows the name and, when enabled, the path', () => {
    const loc = { id: BIN, name: 'Bin 3', path: 'Workshop / Shelf B' };
    expect(locationLabelLines(loc, template({ showLocation: true }))).toEqual([
      'Bin 3',
      'Workshop / Shelf B',
    ]);
    expect(locationLabelLines(loc, template({ showLocation: false }))).toEqual(['Bin 3']);
  });
});

describe('toLocationLabelCell', () => {
  it('encodes the location deep-link in the QR', () => {
    const cell = toLocationLabelCell({ id: BIN, name: 'Bin 3' }, BASE, template());
    expect(cell.url).toBe(buildLocationQrUrl(BIN, BASE));
    expect(cell.qrSvg).toContain('<svg');
  });

  it('encodes the location name as the barcode value', () => {
    const cell = toLocationLabelCell({ id: BIN, name: 'BIN3' }, BASE, template({ symbology: 'barcode' }));
    expect(cell.barcodeValue).toBe('BIN3');
    expect(cell.barcodeFit).toBe('ok');
    expect(cell.barcodeSvg).toContain('<svg');
  });

  it('falls back to a short id when the name is too long to print readably (issue #331)', () => {
    // A location name is free text of any length; Code 128 is 11 modules per character,
    // so this would collapse to about a tenth of a millimetre per bar — a grey smear.
    const cell = toLocationLabelCell(
      { id: BIN, name: 'Workshop shelf B, third drawer' },
      BASE,
      template({ symbology: 'barcode' }),
    );
    expect(cell.barcodeValue).toBe('00000000');
    expect(cell.barcodeFit).toBe('shortened');
    expect(cell.barcodeSvg).toContain('<svg');
    // The name still prints as text — only the barcode gives it up.
    expect(cell.lines).toContain('Workshop shelf B, third drawer');
  });

  it('prints no barcode at all on a label too narrow for even the short id', () => {
    const cell = toLocationLabelCell(
      { id: BIN, name: 'BIN3' },
      BASE,
      template({ symbology: 'barcode', sizeMode: 'die-cut', labelWidthMm: 20, labelHeightMm: 15 }),
    );
    expect(cell.barcodeValue).toBeNull();
    expect(cell.barcodeSvg).toBeNull();
    expect(cell.barcodeFit).toBe('unprintable');
  });
});

describe('buildLocationLabelHtml', () => {
  it('repeats the label cell `copies` times in a self-contained document', () => {
    const html = buildLocationLabelHtml({ id: BIN, name: 'Bin 3' }, BASE, template(), 4);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(countOccurrences(html, '<svg')).toBe(4);
    expect(countOccurrences(html, 'Bin 3')).toBe(4);
  });

  it('clamps an out-of-range copy count', () => {
    const html = buildLocationLabelHtml({ id: BIN, name: 'Bin 3' }, BASE, template(), 0);
    expect(countOccurrences(html, '<svg')).toBe(1);
  });
});
