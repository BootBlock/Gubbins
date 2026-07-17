import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { metricHasContent, resolveVisualCardMetric } from './visual-card-metric';

/**
 * The pure Visual-card hero resolution (issue #107): `metricHasContent` decides whether a
 * metric has something to show for an item, and `resolveVisualCardMetric` picks the primary,
 * then the fallback, then the primary again (so it draws its own placeholder). The rendered
 * output of each metric lives in DiscreteCardMetric.test.tsx; here we cover the branching.
 */

const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 100,
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
};

const item = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

describe('metricHasContent', () => {
  it('stock health and last updated are always available', () => {
    expect(metricHasContent('stockHealth', item())).toBe(true);
    expect(metricHasContent('lastUpdated', item())).toBe(true);
  });

  it('total value needs a countable, priced item', () => {
    expect(metricHasContent('value', item({ unitCost: 2.5 }))).toBe(true);
    expect(metricHasContent('value', item({ unitCost: null }))).toBe(false);
    // An unlimited or gauge item has no meaningful unit total, matching the value card field.
    expect(metricHasContent('value', item({ unitCost: 2.5, isUnlimited: true }))).toBe(false);
    expect(metricHasContent('value', item({ unitCost: 2.5, trackingMode: 'CONSUMABLE_GAUGE' }))).toBe(false);
  });

  it('condition needs a tracked condition', () => {
    expect(metricHasContent('condition', item({ condition: 'GOOD' }))).toBe(true);
    expect(metricHasContent('condition', item({ condition: null }))).toBe(false);
  });

  it('manufacturer needs printable (non-whitespace) text', () => {
    expect(metricHasContent('manufacturer', item({ manufacturer: 'Texas Instruments' }))).toBe(true);
    expect(metricHasContent('manufacturer', item({ manufacturer: null }))).toBe(false);
    expect(metricHasContent('manufacturer', item({ manufacturer: '   ' }))).toBe(false);
  });
});

describe('resolveVisualCardMetric', () => {
  it('renders the primary when it has content (the fallback is ignored)', () => {
    expect(resolveVisualCardMetric(item({ manufacturer: 'ACME' }), 'manufacturer', 'stockHealth')).toBe(
      'manufacturer',
    );
  });

  it('falls back when the primary is empty and the fallback has content', () => {
    // The issue's worked example: Manufacturer primary, Stock health fallback, no maker set.
    expect(resolveVisualCardMetric(item({ manufacturer: null }), 'manufacturer', 'stockHealth')).toBe(
      'stockHealth',
    );
  });

  it('keeps the primary (its own placeholder) when the fallback is "none"', () => {
    expect(resolveVisualCardMetric(item({ manufacturer: null }), 'manufacturer', 'none')).toBe(
      'manufacturer',
    );
  });

  it('keeps the primary when the fallback is also empty for that item', () => {
    // Manufacturer primary, Condition fallback, but the item has neither.
    expect(resolveVisualCardMetric(item(), 'manufacturer', 'condition')).toBe('manufacturer');
  });

  it('the default primary + "none" always returns the primary (pre-issue-#107 behaviour)', () => {
    expect(resolveVisualCardMetric(item(), 'stockHealth', 'none')).toBe('stockHealth');
  });
});
