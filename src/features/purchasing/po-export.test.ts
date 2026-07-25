import { describe, it, expect } from 'vitest';
import type { PurchaseOrderLine, PurchaseOrderWithLines } from '@/db/repositories';
import { buildPurchaseOrdersExport, poExportColumns, purchaseOrdersExportFilename } from './po-export';

function line(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'l1',
    poId: 'po1',
    itemId: 'i1',
    supplierPartId: null,
    description: 'Brass widget',
    orderedQty: 10,
    receivedQty: 0,
    unitCost: 2.5,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function order(overrides: Partial<PurchaseOrderWithLines> = {}): PurchaseOrderWithLines {
  return {
    id: 'po1',
    supplierId: 's1',
    supplierName: 'Example Supplies Ltd',
    reference: 'PO-1001',
    status: 'ORDERED',
    currency: null,
    createdAt: Date.parse('2026-07-20T09:00:00Z'),
    orderedAt: Date.parse('2026-07-21T09:00:00Z'),
    updatedAt: 0,
    lines: [line()],
    effectiveStatus: 'ORDERED',
    ...overrides,
  };
}

/** Sterling-like base unless a test says otherwise. */
const BASE_DECIMALS = 2;

const cells = (row: PurchaseOrderWithLines, baseDecimals = BASE_DECIMALS): Record<string, unknown> =>
  Object.fromEntries(poExportColumns(baseDecimals).map((c) => [c.header, c.value(row)]));

describe('poExportColumns', () => {
  it('summarises the master row: identity, status, line totals and value', () => {
    expect(cells(order())).toEqual({
      Reference: 'PO-1001',
      Supplier: 'Example Supplies Ltd',
      Status: 'Ordered',
      Lines: 1,
      'Ordered qty': 10,
      'Received qty': 0,
      Currency: null,
      Total: 25,
      Created: '2026-07-20T09:00:00.000Z',
      Ordered: '2026-07-21T09:00:00.000Z',
    });
  });

  it('reports the effective status the row badges, not the stored snapshot', () => {
    // A partially-received order stores ORDERED but badges "Partially received"; the file has to
    // agree with the screen, or an exported order book contradicts the one it was read from.
    const row = cells(order({ status: 'ORDERED', effectiveStatus: 'PARTIAL' }));
    expect(row.Status).toBe('Partially received');
  });

  it('sums quantities across every line', () => {
    const row = cells(
      order({
        lines: [line({ orderedQty: 10, receivedQty: 4 }), line({ id: 'l2', orderedQty: 5, receivedQty: 5 })],
      }),
    );
    expect(row.Lines).toBe(2);
    expect(row['Ordered qty']).toBe(15);
    expect(row['Received qty']).toBe(9);
  });

  it('quantises the total to the order’s own currency, not a flat 2dp', () => {
    // A yen-quoted order totals in whole yen even under a sterling base (issue #292) — the line
    // costs were copied from the supplier's quote and are never converted.
    const yen = cells(order({ currency: 'JPY', lines: [line({ orderedQty: 3, unitCost: 100.4 })] }));
    expect(yen.Currency).toBe('JPY');
    expect(yen.Total).toBe(301);
  });

  it('leaves the currency blank for a base-currency order, as the stored column does', () => {
    expect(cells(order({ currency: null })).Currency).toBeNull();
  });

  it('totals a currency-less order at the BASE minor unit, not a flat 2dp', () => {
    // A null currency means "the base currency" (issue #292). Quantising it at 2dp would put a
    // half-yen in the file under a JPY base — an amount the currency cannot hold — and would
    // disagree with the figure the master list rendered for the very same order.
    const yenBase = cells(order({ currency: null, lines: [line({ orderedQty: 3, unitCost: 100.5 })] }), 0);
    expect(yenBase.Total).toBe(302);
  });

  it('keeps a 3dp base currency’s precision on a currency-less order', () => {
    const bahrainiBase = cells(
      order({ currency: null, lines: [line({ orderedQty: 1, unitCost: 1.2345 })] }),
      3,
    );
    expect(bahrainiBase.Total).toBe(1.235);
  });

  it('uses the order’s own currency over the base when it names one', () => {
    // The base being 0dp must not quantise a sterling-quoted order down to whole pounds.
    const sterlingOrder = cells(
      order({ currency: 'GBP', lines: [line({ orderedQty: 1, unitCost: 12.34 })] }),
      0,
    );
    expect(sterlingOrder.Total).toBe(12.34);
  });

  it('treats a line with no unit cost as contributing nothing to the total', () => {
    const row = cells(
      order({ lines: [line({ unitCost: null }), line({ id: 'l2', unitCost: 2, orderedQty: 3 })] }),
    );
    expect(row.Total).toBe(6);
  });

  it('leaves a never-ordered draft’s ordered date blank', () => {
    expect(cells(order({ orderedAt: null, effectiveStatus: 'DRAFT' })).Ordered).toBeNull();
  });
});

describe('buildPurchaseOrdersExport', () => {
  it('serialises one row per order through the shared exporter', async () => {
    const { content } = await buildPurchaseOrdersExport(
      'csv',
      [order(), order({ id: 'po2', reference: 'PO-1002' })],
      BASE_DECIMALS,
    );
    const lines = String(content).split('\r\n');
    expect(lines[0]).toBe(
      'Reference,Supplier,Status,Lines,Ordered qty,Received qty,Currency,Total,Created,Ordered',
    );
    expect(lines).toHaveLength(3);
  });

  it('captions a single order in the singular', async () => {
    const { content } = await buildPurchaseOrdersExport('txt', [order()], BASE_DECIMALS);
    expect(String(content)).toContain('1 order\n');
  });
});

describe('purchaseOrdersExportFilename', () => {
  it('is date-stamped and carries the chosen extension', () => {
    expect(purchaseOrdersExportFilename('csv', new Date('2026-07-25T00:00:00Z'))).toBe(
      'gubbins-purchase-orders-2026-07-25.csv',
    );
  });
});
