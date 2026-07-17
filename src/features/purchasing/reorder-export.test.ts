import { describe, it, expect } from 'vitest';
import type { ReorderPlanGroup } from './reorder-plan';
import { buildReorderExport, flattenReorderPlan, reorderExportColumns } from './reorder-export';

function makeGroup(overrides: Partial<ReorderPlanGroup> = {}): ReorderPlanGroup {
  return {
    supplierKey: 'acme',
    supplierName: 'Acme Parts',
    lines: [
      {
        itemId: 'i1',
        itemName: 'NE555 timer',
        supplierPartId: 'sp1',
        orderQty: 10,
        onOrder: 0,
        unitCost: 0.25,
      },
      { itemId: 'i2', itemName: 'Cap, 10µF', supplierPartId: 'sp2', orderQty: 2, onOrder: 3, unitCost: null },
    ],
    ...overrides,
  };
}

describe('flattenReorderPlan', () => {
  it('produces one self-contained row per line with the supplier repeated', () => {
    const rows = flattenReorderPlan([makeGroup()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ supplier: 'Acme Parts', item: 'NE555 timer', orderQty: 10, unitCost: 0.25 });
    expect(rows[1]!.supplier).toBe('Acme Parts');
    expect(rows[1]!.unitCost).toBeNull();
  });

  it('flattens across multiple supplier groups in order', () => {
    const rows = flattenReorderPlan([
      makeGroup(),
      makeGroup({
        supplierKey: 'other',
        supplierName: 'Other Co',
        lines: [
          { itemId: 'i3', itemName: 'Bolt', supplierPartId: 'sp3', orderQty: 1, onOrder: 0, unitCost: 1 },
        ],
      }),
    ]);
    expect(rows.map((r) => r.supplier)).toEqual(['Acme Parts', 'Acme Parts', 'Other Co']);
  });
});

describe('reorderExportColumns', () => {
  it('keeps the stable header set for spreadsheet round-trips', () => {
    expect(reorderExportColumns().map((c) => c.header)).toEqual(['supplier', 'item', 'orderQty', 'unitCost']);
  });
});

describe('buildReorderExport', () => {
  it('builds a CSV whose header + rows match the flattened plan (RFC-4180 quoting)', async () => {
    const { content, mimeType, extension } = await buildReorderExport([makeGroup()], 'csv');
    expect(mimeType).toContain('text/csv');
    expect(extension).toBe('csv');
    const out = (content as string).split('\r\n');
    expect(out[0]).toBe('supplier,item,orderQty,unitCost');
    expect(out[1]).toBe('Acme Parts,NE555 timer,10,0.25');
    // A comma-bearing item name is quoted; a null unit cost is blank.
    expect(out[2]).toBe('Acme Parts,"Cap, 10µF",2,');
  });

  it('offers the other formats with a titled document and line count', async () => {
    const tsv = (await buildReorderExport([makeGroup()], 'tsv')).content as string;
    expect(tsv.split('\r\n')[0]).toContain('\t');
    const md = (await buildReorderExport([makeGroup()], 'markdown')).content;
    expect(md).toContain('# Reorder & shopping list');
    const html = (await buildReorderExport([makeGroup()], 'html')).content;
    expect(html).toContain('<title>Reorder &amp; shopping list</title>');
    expect(html).toContain('2 lines');
  });

  it('is header-only for an empty plan', async () => {
    expect((await buildReorderExport([], 'csv')).content).toBe('supplier,item,orderQty,unitCost');
  });
});
