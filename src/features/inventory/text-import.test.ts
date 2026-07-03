/**
 * Unit tests for the generalised import engine (Phase: generalised import dialog).
 *
 * Pure logic only — no DB, no React. Covers format detection, the free-form line
 * heuristics, extraction into a row matrix, and that everything flows through the
 * shared plan builder to produce create / update / error partitions with a matching
 * preview.
 */
import { describe, it, expect } from 'vitest';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { Item } from '@/db/repositories/types';
import {
  detectImportFormat,
  parseFreeformLine,
  parseFreeformText,
  extractImport,
  buildImportPlan,
  buildPreviewRows,
} from './text-import';

/** A minimal Item stub for existing-item lists (only fields the importer reads). */
function stubItem(id: string, name: string, mpn: string | null = null): Item {
  return {
    id,
    name,
    mpn,
    description: null,
    locationId: UNASSIGNED_LOCATION_ID,
    categoryId: null,
    trackingMode: 'DISCRETE',
    quantity: 0,
    serialNo: null,
    manufacturer: null,
    unitCost: null,
    expiryDate: null,
    batchNumber: null,
    lotNumber: null,
    condition: null,
    parentId: null,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    operationalMetadata: null,
  };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

describe('detectImportFormat', () => {
  it('detects a tab-separated paste', () => {
    expect(detectImportFormat('name\tqty\nWidget\t5\nSprocket\t9')).toBe('tsv');
  });

  it('detects comma-separated values', () => {
    expect(detectImportFormat('name,qty\nWidget,5\nSprocket,9')).toBe('csv');
  });

  it('prefers tabs when both delimiters are consistently present', () => {
    expect(detectImportFormat('a\tb, c\nx\ty, z')).toBe('tsv');
  });

  it('falls back to a line list when no delimiter is consistent', () => {
    expect(detectImportFormat('Resistor 10k x50\nCapacitor 100nF\n3x Arduino Uno')).toBe('lines');
  });

  it('treats an empty string as a line list', () => {
    expect(detectImportFormat('   ')).toBe('lines');
  });

  it('does not treat a single stray comma as CSV', () => {
    // Inconsistent column counts -> not tabular.
    expect(detectImportFormat('Widget, the big one\nSprocket')).toBe('lines');
  });

  it('detects semicolon-separated values', () => {
    expect(detectImportFormat('name;qty\nWidget;5\nSprocket;9')).toBe('ssv');
  });

  it('detects a JSON array', () => {
    expect(detectImportFormat('[{"name":"Widget"}]')).toBe('json');
  });

  it('does not mistake invalid brace-text for JSON', () => {
    expect(detectImportFormat('{this is not json}')).toBe('lines');
  });

  it('detects a Markdown table', () => {
    expect(detectImportFormat('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('markdown');
  });
});

// ---------------------------------------------------------------------------
// Free-form line heuristics
// ---------------------------------------------------------------------------

describe('parseFreeformLine', () => {
  it('returns null for a blank line', () => {
    expect(parseFreeformLine('   ')).toBeNull();
  });

  it('reads a plain name with default quantity 1', () => {
    expect(parseFreeformLine('Arduino Uno')).toEqual({ name: 'Arduino Uno', quantity: 1, sku: null });
  });

  it('reads a trailing "x50" multiplier', () => {
    expect(parseFreeformLine('Resistor 10k x50')).toEqual({
      name: 'Resistor 10k',
      quantity: 50,
      sku: null,
    });
  });

  it('reads a leading "3x" multiplier', () => {
    expect(parseFreeformLine('3x Arduino Uno')).toEqual({
      name: 'Arduino Uno',
      quantity: 3,
      sku: null,
    });
  });

  it('reads a "qty:" label', () => {
    expect(parseFreeformLine('Capacitor 100nF (qty: 20)')).toEqual({
      name: 'Capacitor 100nF',
      quantity: 20,
      sku: null,
    });
  });

  it('reads a trailing comma quantity', () => {
    expect(parseFreeformLine('M3 bolts, 50')).toEqual({ name: 'M3 bolts', quantity: 50, sku: null });
  });

  it('extracts a labelled SKU without mistaking part-number digits for quantity', () => {
    expect(parseFreeformLine('Capacitor 100nF, sku: C-100-42')).toEqual({
      name: 'Capacitor 100nF',
      quantity: 1,
      sku: 'C-100-42',
    });
  });

  it('does not treat a dimension spec as a quantity', () => {
    expect(parseFreeformLine('M3 x 10mm bolt')).toEqual({
      name: 'M3 x 10mm bolt',
      quantity: 1,
      sku: null,
    });
  });

  it('combines a quantity multiplier and a SKU label', () => {
    // Shorthand quantity precedes the trailing labels; the label value is a single token.
    expect(parseFreeformLine('Widget x12 mpn: W-9')).toEqual({
      name: 'Widget',
      quantity: 12,
      sku: 'W-9',
    });
  });

  it('extracts an inline manufacturer (multi-word) and defaults quantity to 1', () => {
    expect(parseFreeformLine('Multimeter manu: Fluke Corporation')).toEqual({
      name: 'Multimeter',
      quantity: 1,
      sku: null,
      manufacturer: 'Fluke Corporation',
    });
  });

  it('extracts an inline location and tracking mode', () => {
    expect(parseFreeformLine('Oscilloscope loc: Bench track: serialised')).toEqual({
      name: 'Oscilloscope',
      quantity: 1,
      sku: null,
      location: 'Bench',
      trackingMode: 'serialised',
    });
  });

  it('reads a labelled quantity anywhere in the line', () => {
    expect(parseFreeformLine('Bolts q: 200 loc: Drawer 3')).toEqual({
      name: 'Bolts',
      quantity: 200,
      sku: null,
      location: 'Drawer 3',
    });
  });

  it('recognises a bare Amazon ASIN as the SKU and strips it from the name', () => {
    expect(parseFreeformLine('USB-C cable B0F3XF5ZKF x3')).toEqual({
      name: 'USB-C cable',
      quantity: 3,
      sku: 'B0F3XF5ZKF',
    });
  });

  it('recognises an Amazon listing URL and names an id-only line after the ASIN', () => {
    expect(parseFreeformLine('https://www.amazon.co.uk/dp/B0F3XF5ZKF?th=1')).toEqual({
      name: 'B0F3XF5ZKF',
      quantity: 1,
      sku: 'B0F3XF5ZKF',
    });
  });

  it('lets an explicit sku: label win over an ASIN in the line', () => {
    expect(parseFreeformLine('Cable B0F3XF5ZKF sku: MY-PART')).toEqual({
      name: 'Cable',
      quantity: 1,
      sku: 'MY-PART',
    });
  });

  it('extracts a currency-marked unit price as the unit cost', () => {
    expect(parseFreeformLine('Anker charger £12.99')).toEqual({
      name: 'Anker charger',
      quantity: 1,
      sku: null,
      unitCost: 12.99,
    });
  });

  it('parses an invoice-style line with ASIN, price (thousands) and quantity together', () => {
    expect(parseFreeformLine('Widget kit B0F3XF5ZKF $1,234.50 x2')).toEqual({
      name: 'Widget kit',
      quantity: 2,
      sku: 'B0F3XF5ZKF',
      unitCost: 1234.5,
    });
  });

  it('does not treat a bare number as a price', () => {
    expect(parseFreeformLine('Screw 4.5mm')).toEqual({
      name: 'Screw 4.5mm',
      quantity: 1,
      sku: null,
    });
  });
});

describe('parseFreeformText', () => {
  it('parses each non-blank line and skips blanks', () => {
    const items = parseFreeformText('Resistor 10k x50\n\n  \n3x Arduino Uno');
    expect(items).toEqual([
      { name: 'Resistor 10k', quantity: 50, sku: null },
      { name: 'Arduino Uno', quantity: 3, sku: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe('extractImport', () => {
  it('flattens a line list into name / quantity / sku / manufacturer / location / tracking / unit-cost columns', () => {
    const ex = extractImport('Resistor 10k x50\nArduino Uno');
    expect(ex.format).toBe('lines');
    expect(ex.isTabular).toBe(false);
    expect(ex.columns).toEqual([
      'Name',
      'Quantity',
      'SKU',
      'Manufacturer',
      'Location',
      'Tracking',
      'Unit cost',
    ]);
    // Explicit quantity kept; a bare name defaults to 1 (unlikely to be added with none).
    expect(ex.dataRows).toEqual([
      ['Resistor 10k', '50', '', '', '', '', ''],
      ['Arduino Uno', '1', '', '', '', '', ''],
    ]);
  });

  it('carries inline manufacturer / location / tracking into the line-list columns', () => {
    const ex = extractImport('Multimeter manu: Fluke loc: Bench track: serialised q: 2');
    expect(ex.dataRows).toEqual([['Multimeter', '2', '', 'Fluke', 'Bench', 'serialised', '']]);
  });

  it('carries an ASIN and a currency price from a line into the SKU / unit-cost columns', () => {
    const ex = extractImport('Anker USB-C cable B0F3XF5ZKF £9.99 x2');
    expect(ex.dataRows).toEqual([['Anker USB-C cable', '2', 'B0F3XF5ZKF', '', '', '', '9.99']]);
  });

  it('parses a TSV paste and infers the mapping from headers', () => {
    const ex = extractImport('name\tqty\tmpn\nWidget\t5\tW-1');
    expect(ex.format).toBe('tsv');
    expect(ex.isTabular).toBe(true);
    expect(ex.dataRows).toEqual([['Widget', '5', 'W-1']]);
    expect(ex.mapping).toEqual(['name', 'quantity', 'sku']);
  });

  it('honours a forced format override', () => {
    // Text that would auto-detect as a line list, forced to CSV.
    const ex = extractImport('Widget, the big one\nSprocket', { format: 'csv' });
    expect(ex.format).toBe('csv');
    expect(ex.isTabular).toBe(true);
  });

  it('treats delimited input as headerless when hasHeader is false', () => {
    const ex = extractImport('Widget,5\nSprocket,9', { format: 'csv', hasHeader: false });
    expect(ex.columns).toEqual(['Column 1', 'Column 2']);
    expect(ex.dataRows).toEqual([
      ['Widget', '5'],
      ['Sprocket', '9'],
    ]);
  });

  it('parses a JSON array of objects into columns from the key union', () => {
    const ex = extractImport('[{"name":"Widget","qty":5},{"name":"Sprocket","mpn":"S-1"}]');
    expect(ex.format).toBe('json');
    expect(ex.isTabular).toBe(true);
    expect(ex.headerRow).toEqual(['name', 'qty', 'mpn']);
    expect(ex.dataRows).toEqual([
      ['Widget', '5', ''],
      ['Sprocket', '', 'S-1'],
    ]);
    expect(ex.mapping).toEqual(['name', 'quantity', 'sku']);
  });

  it('unwraps a JSON object with an array property', () => {
    const ex = extractImport('{"items":[{"name":"Widget"}]}');
    expect(ex.format).toBe('json');
    expect(ex.dataRows).toEqual([['Widget']]);
  });

  it('treats a JSON array of strings as item names', () => {
    const ex = extractImport('["Widget","Sprocket"]');
    expect(ex.headerRow).toEqual(['name']);
    expect(ex.dataRows).toEqual([['Widget'], ['Sprocket']]);
  });

  it('reports a note for malformed JSON without throwing', () => {
    const ex = extractImport('{ not valid json ', { format: 'json' });
    expect(ex.dataRows).toEqual([]);
    expect(ex.note).toBeTruthy();
  });

  it('parses a Markdown table', () => {
    const md = ['| name | qty |', '| --- | --- |', '| Widget | 5 |', '| Sprocket | 9 |'].join('\n');
    const ex = extractImport(md);
    expect(ex.format).toBe('markdown');
    expect(ex.headerRow).toEqual(['name', 'qty']);
    expect(ex.dataRows).toEqual([
      ['Widget', '5'],
      ['Sprocket', '9'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Plan + preview
// ---------------------------------------------------------------------------

describe('buildImportPlan + buildPreviewRows', () => {
  it('creates new items from a line list and previews them', () => {
    const ex = extractImport('Resistor 10k x50\nArduino Uno');
    const plan = buildImportPlan(ex, ex.mapping, []);
    expect(plan.create).toHaveLength(2);
    expect(plan.update).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
    expect(plan.create[0]!.input.name).toBe('Resistor 10k');
    expect(plan.create[0]!.input.quantity).toBe(50);
    // A bare name defaults to quantity 1.
    expect(plan.create[1]!.input.quantity).toBe(1);

    const preview = buildPreviewRows(ex.dataRows, ex.mapping, plan);
    expect(preview).toEqual([
      { sourceRow: 1, name: 'Resistor 10k', quantity: '50', sku: '', manufacturer: '', status: 'create' },
      { sourceRow: 2, name: 'Arduino Uno', quantity: '1', sku: '', manufacturer: '', status: 'create' },
    ]);
  });

  it('matches an existing item by name and marks it for update', () => {
    const existing = [stubItem('i1', 'Arduino Uno')];
    const ex = extractImport('Arduino Uno x3');
    const plan = buildImportPlan(ex, ex.mapping, existing, { matchKey: 'name' });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.itemId).toBe('i1');

    const preview = buildPreviewRows(ex.dataRows, ex.mapping, plan);
    expect(preview[0]!.status).toBe('update');
  });

  it('resolves an inline location name and applies a batch default tracking mode', () => {
    const ex = extractImport('Widget loc: Workshop\nGizmo');
    const plan = buildImportPlan(ex, ex.mapping, [], {
      locations: [{ id: 'loc-1', name: 'Workshop' }],
      defaultLocationId: 'loc-0',
      defaultTrackingMode: 'SERIALISED',
    });
    expect(plan.errors).toHaveLength(0);
    // Inline location wins for row 1; the batch default fills row 2.
    expect(plan.create[0]!.input.locationId).toBe('loc-1');
    expect(plan.create[1]!.input.locationId).toBe('loc-0');
    expect(plan.create.every((c) => c.input.trackingMode === 'SERIALISED')).toBe(true);
  });

  it('surfaces per-row errors in the preview', () => {
    // A negative quantity is rejected by the row schema.
    const ex = extractImport('name,qty\nWidget,-5', { format: 'csv' });
    const plan = buildImportPlan(ex, ex.mapping, []);
    expect(plan.errors).toHaveLength(1);
    const preview = buildPreviewRows(ex.dataRows, ex.mapping, plan);
    expect(preview[0]!.status).toBe('error');
    expect(preview[0]!.message).toBeTruthy();
  });
});
