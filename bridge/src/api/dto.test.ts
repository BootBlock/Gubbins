/**
 * DTO mapper tests — the public `/api/v1` item projection. Focus: the Phase-82
 * unlimited-supply contract, where an infinite source serialises `quantity: null`
 * alongside `isUnlimited: true` (JSON has no `Infinity`).
 */
import { describe, expect, it } from 'vitest';
import type { Item } from '@/db/repositories/types';
import { toItemSummary } from './dto.ts';

/** A complete, finite DISCRETE item; override any field per test. */
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    name: 'M3 bolt',
    description: null,
    notes: null,
    locationId: 'loc-1',
    categoryId: null,
    trackingMode: 'DISCRETE',
    quantity: 42,
    serialNo: null,
    mpn: null,
    manufacturer: null,
    barcode: null,
    unitCost: null,
    expiryDate: null,
    batchNumber: null,
    lotNumber: null,
    condition: null,
    parentId: null,
    isUnlimited: false,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    acquiredAt: null,
    warrantyExpiresAt: null,
    purchasePrice: null,
    depreciationMonths: null,
    weight: null,
    width: null,
    height: null,
    depth: null,
    currentValue: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    operationalMetadata: null,
    ...overrides,
  };
}

describe('toItemSummary — unlimited supply (Phase 82)', () => {
  it('serialises a finite item with its real quantity and isUnlimited: false', () => {
    const dto = toItemSummary(makeItem({ quantity: 42 }), 'Drawer A');
    expect(dto.quantity).toBe(42);
    expect(dto.isUnlimited).toBe(false);
  });

  it('serialises an unlimited item as quantity: null with isUnlimited: true', () => {
    // An effectively infinite source has no finite count; JSON has no Infinity, so null it.
    const dto = toItemSummary(makeItem({ isUnlimited: true, quantity: 0 }), 'Tap');
    expect(dto.quantity).toBeNull();
    expect(dto.isUnlimited).toBe(true);
    // The stored integer is ignored — even a non-zero quantity nulls out.
    expect(toItemSummary(makeItem({ isUnlimited: true, quantity: 7 }), null).quantity).toBeNull();
  });
});
