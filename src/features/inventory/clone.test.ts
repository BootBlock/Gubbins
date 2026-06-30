import { describe, expect, it } from 'vitest';
import type { Item, ResolvedItemField, SupplierPart } from '@/db/repositories';
import {
  CLONE_NAME_SUFFIX,
  clonedFieldValues,
  clonedSupplierPartInput,
  planItemClone,
} from './clone';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'src',
    name: 'Widget',
    description: 'A useful widget',
    locationId: 'loc-1',
    categoryId: 'cat-1',
    trackingMode: 'DISCRETE',
    quantity: 42,
    serialNo: null,
    mpn: 'WID-123',
    manufacturer: 'Acme',
    unitCost: 1.5,
    expiryDate: 1_700_000_000_000,
    batchNumber: 'B-1',
    lotNumber: 'L-9',
    condition: 'GOOD',
    parentId: null,
    reorderPoint: 5,
    reorderGaugePercent: null,
    reorderQty: 10,
    acquiredAt: '2024-01-01',
    warrantyExpiresAt: '2026-01-01',
    purchasePrice: 99,
    depreciationMonths: 36,
    isActive: true,
    createdAt: 1,
    updatedAt: 2,
    gauge: null,
    operationalMetadata: { foo: 'bar' },
    ...overrides,
  };
}

describe('planItemClone', () => {
  it('copies template fields and appends the copy suffix', () => {
    const seed = planItemClone(makeItem());
    expect(seed.name).toBe(`Widget${CLONE_NAME_SUFFIX}`);
    expect(seed.description).toBe('A useful widget');
    expect(seed.locationId).toBe('loc-1');
    expect(seed.categoryId).toBe('cat-1');
    expect(seed.mpn).toBe('WID-123');
    expect(seed.manufacturer).toBe('Acme');
    expect(seed.unitCost).toBe(1.5);
    expect(seed.condition).toBe('GOOD');
    expect(seed.reorderPoint).toBe(5);
    expect(seed.reorderQty).toBe(10);
    expect(seed.depreciationMonths).toBe(36);
    expect(seed.trackingMode).toBe('DISCRETE');
  });

  it('strips per-instance identity fields', () => {
    const seed = planItemClone(makeItem()) as Record<string, unknown>;
    // None of the instance-identity fields are carried into the create seed.
    expect(seed.batchNumber).toBeUndefined();
    expect(seed.lotNumber).toBeUndefined();
    expect(seed.expiryDate).toBeUndefined();
    expect(seed.acquiredAt).toBeUndefined();
    expect(seed.warrantyExpiresAt).toBeUndefined();
    expect(seed.purchasePrice).toBeUndefined();
  });

  it('resets a DISCRETE clone quantity to 0', () => {
    expect(planItemClone(makeItem({ quantity: 42 })).quantity).toBe(0);
  });

  it('clones a gauge shape with the net value reset to 0', () => {
    const seed = planItemClone(
      makeItem({
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: {
          unitOfMeasure: 'g',
          grossCapacity: 1000,
          tareWeight: 200,
          currentNetValue: 750,
          percentageRemaining: 75,
          currentGrossWeight: 950,
        },
      }),
    );
    expect(seed.gauge).toEqual({
      unitOfMeasure: 'g',
      grossCapacity: 1000,
      tareWeight: 200,
      currentNetValue: 0,
    });
    expect(seed.quantity).toBeUndefined();
  });

  it('requests a single fresh instance for a SERIALISED clone', () => {
    const seed = planItemClone(makeItem({ trackingMode: 'SERIALISED', quantity: 1, serialNo: 7 }));
    expect(seed.count).toBe(1);
    expect((seed as Record<string, unknown>).serialNo).toBeUndefined();
  });

  it('honours a custom name suffix', () => {
    expect(planItemClone(makeItem(), { nameSuffix: ' #2' }).name).toBe('Widget #2');
  });
});

describe('clonedSupplierPartInput', () => {
  it('maps a supplier part to a creation input, preserving preferred and price breaks', () => {
    const part: SupplierPart = {
      id: 'sp-1',
      itemId: 'src',
      supplierName: 'Mouser',
      orderCode: 'M-1',
      unitCost: 0.2,
      currency: null,
      packQty: 100,
      minOrderQty: 10,
      priceBreaks: [{ qty: 100, unitCost: 0.18 }],
      url: 'https://example.test/part',
      isPreferred: true,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(clonedSupplierPartInput(part)).toEqual({
      supplierName: 'Mouser',
      orderCode: 'M-1',
      unitCost: 0.2,
      currency: null,
      packQty: 100,
      minOrderQty: 10,
      priceBreaks: [{ qty: 100, unitCost: 0.18 }],
      url: 'https://example.test/part',
      isPreferred: true,
    });
  });

  it('passes null price breaks when there are none', () => {
    const part = {
      id: 'sp', itemId: 'src', supplierName: 'S', orderCode: null, unitCost: null,
      currency: null, packQty: null, minOrderQty: null, priceBreaks: [], url: null,
      isPreferred: false, createdAt: 1, updatedAt: 2,
    } satisfies SupplierPart;
    expect(clonedSupplierPartInput(part).priceBreaks).toBeNull();
  });
});

describe('clonedFieldValues', () => {
  const field = (over: Partial<ResolvedItemField>): ResolvedItemField =>
    ({
      id: 'f', categoryId: 'cat-1', name: 'Voltage', type: 'NUMBER', position: 0,
      required: false, options: null, defaultValue: null, updatedAt: 0,
      value: null, hasStoredValue: false, ...over,
    }) as ResolvedItemField;

  it('keeps only stored, non-null values keyed by field id', () => {
    const fields = [
      field({ id: 'a', value: '16', hasStoredValue: true }),
      field({ id: 'b', value: 'NP0', hasStoredValue: false }), // default only — not copied
      field({ id: 'c', value: null, hasStoredValue: true }),
    ];
    expect(clonedFieldValues(fields)).toEqual({ a: '16' });
  });

  it('returns an empty map when nothing is stored', () => {
    expect(clonedFieldValues([])).toEqual({});
  });
});
