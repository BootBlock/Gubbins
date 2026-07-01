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

  it('combines a SKU label and a quantity multiplier', () => {
    expect(parseFreeformLine('Widget mpn: W-9 x12')).toEqual({
      name: 'Widget',
      quantity: 12,
      sku: 'W-9',
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
  it('flattens a line list into name / quantity / sku columns', () => {
    const ex = extractImport('Resistor 10k x50\nArduino Uno');
    expect(ex.format).toBe('lines');
    expect(ex.isTabular).toBe(false);
    expect(ex.columns).toEqual(['Name', 'Quantity', 'SKU']);
    // Explicit quantity kept; default (1) left blank so it does not overwrite stock.
    expect(ex.dataRows).toEqual([
      ['Resistor 10k', '50', ''],
      ['Arduino Uno', '', ''],
    ]);
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
    // A blank quantity cell falls back to the catalogue default of 0.
    expect(plan.create[1]!.input.quantity).toBe(0);

    const preview = buildPreviewRows(ex.dataRows, ex.mapping, plan);
    expect(preview).toEqual([
      { sourceRow: 1, name: 'Resistor 10k', quantity: '50', sku: '', status: 'create' },
      { sourceRow: 2, name: 'Arduino Uno', quantity: '', sku: '', status: 'create' },
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
