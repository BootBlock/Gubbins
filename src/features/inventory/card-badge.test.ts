import { describe, expect, it } from 'vitest';
import type { Item } from '@/db/repositories';
import {
  CARD_BADGE_OPTIONS,
  DEFAULT_CARD_BADGE_CONTENT,
  DEFAULT_CARD_BADGE_FALLBACK,
  normaliseCardBadgeContent,
  resolveCardBadge,
  type CardBadgeContent,
} from './card-badge';

/** A minimal DISCRETE item; override just the fields a case exercises. */
const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 10,
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
  isFavourite: false,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};
const item = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

describe('normaliseCardBadgeContent', () => {
  it('passes every offered content id through unchanged', () => {
    for (const { value } of CARD_BADGE_OPTIONS) {
      expect(normaliseCardBadgeContent(value)).toBe(value);
    }
  });

  it('defaults the primary content to the tracking pill (the historic behaviour)', () => {
    expect(DEFAULT_CARD_BADGE_CONTENT).toBe('tracking');
    expect(normaliseCardBadgeContent('nonsense')).toBe('tracking');
    expect(normaliseCardBadgeContent('')).toBe('tracking');
    expect(normaliseCardBadgeContent(undefined)).toBe('tracking');
    expect(normaliseCardBadgeContent(42)).toBe('tracking');
  });

  it('coerces a stale value to the given fallback default (the fallback preference uses none)', () => {
    expect(DEFAULT_CARD_BADGE_FALLBACK).toBe('none');
    expect(normaliseCardBadgeContent('nonsense', DEFAULT_CARD_BADGE_FALLBACK)).toBe('none');
    // A *valid* value is still passed through regardless of the fallback default.
    expect(normaliseCardBadgeContent('unitPrice', DEFAULT_CARD_BADGE_FALLBACK)).toBe('unitPrice');
  });
});

describe('resolveCardBadge — primary content', () => {
  it('shows the tracking mode for any item (always available)', () => {
    expect(resolveCardBadge(item({ trackingMode: 'SERIALISED' }), 'tracking', 'none')).toEqual({
      kind: 'tracking',
      mode: 'SERIALISED',
    });
  });

  it('shows the unit price when a unit cost is set', () => {
    expect(resolveCardBadge(item({ unitCost: 2.5 }), 'unitPrice', 'none')).toEqual({
      kind: 'money',
      amount: 2.5,
      scope: 'unit',
    });
  });

  it('shows the total value (unit cost × quantity) for a countable priced item', () => {
    expect(resolveCardBadge(item({ unitCost: 2, quantity: 3 }), 'totalValue', 'none')).toEqual({
      kind: 'money',
      amount: 6,
      scope: 'total',
    });
  });

  it('shows the condition when one is tracked', () => {
    expect(resolveCardBadge(item({ condition: 'GOOD' }), 'condition', 'none')).toEqual({
      kind: 'condition',
      condition: 'GOOD',
    });
  });

  it('renders nothing for the "none" content', () => {
    expect(resolveCardBadge(item(), 'none', 'none')).toEqual({ kind: 'none' });
  });
});

describe('resolveCardBadge — availability and fallback', () => {
  it('falls back when the primary content has nothing to show', () => {
    // Unit price on an unpriced item → the tracking fallback.
    expect(resolveCardBadge(item({ unitCost: null }), 'unitPrice', 'tracking')).toEqual({
      kind: 'tracking',
      mode: 'DISCRETE',
    });
    // Condition badge on an item with no condition → the fallback.
    expect(resolveCardBadge(item({ condition: null }), 'condition', 'tracking')).toEqual({
      kind: 'tracking',
      mode: 'DISCRETE',
    });
  });

  it('renders nothing when both the primary and the fallback are unavailable', () => {
    expect(resolveCardBadge(item({ unitCost: null, condition: null }), 'unitPrice', 'condition')).toEqual({
      kind: 'none',
    });
    // An explicit "none" fallback leaves the slot empty when the primary can't apply.
    expect(resolveCardBadge(item({ unitCost: null }), 'unitPrice', 'none')).toEqual({ kind: 'none' });
  });

  it('declines total value for an unlimited or gauge item (no meaningful unit total), then falls back', () => {
    const unlimited = item({ isUnlimited: true, unitCost: 3, quantity: 5 });
    expect(resolveCardBadge(unlimited, 'totalValue', 'unitPrice')).toEqual({
      kind: 'money',
      amount: 3,
      scope: 'unit',
    });
    const gauge = item({ trackingMode: 'CONSUMABLE_GAUGE', unitCost: 4, quantity: 2 });
    expect(resolveCardBadge(gauge, 'totalValue', 'tracking')).toEqual({
      kind: 'tracking',
      mode: 'CONSUMABLE_GAUGE',
    });
  });

  it('still offers the unit price on an unlimited item (a per-unit cost is meaningful)', () => {
    expect(resolveCardBadge(item({ isUnlimited: true, unitCost: 3 }), 'unitPrice', 'none')).toEqual({
      kind: 'money',
      amount: 3,
      scope: 'unit',
    });
  });

  it('treats a non-finite unit cost as unpriced', () => {
    const nan: CardBadgeContent = 'unitPrice';
    expect(resolveCardBadge(item({ unitCost: Number.NaN }), nan, 'none')).toEqual({ kind: 'none' });
  });
});
