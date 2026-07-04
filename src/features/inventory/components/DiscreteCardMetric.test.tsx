import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DiscreteCardMetric } from './DiscreteCardMetric';

/**
 * The Visual card's hero for a plain DISCRETE item: the `visualCardMetric` preference
 * switches between the reorder-derived stock-health band and the total-value figure. The
 * reorder maths itself is the pure {@link discreteStockLevel}/{@link shortfall} seam
 * (covered by reorder-policy.test.ts); here we assert the two rendered branches and the
 * "reorder N" hint that only shows when a DISCRETE item is low.
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
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};

const makeItem = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

beforeEach(() => {
  // Pin the metric-relevant preferences so the branch and threshold are deterministic
  // (the low-stock floor defaults to 5), plus GBP/en-GB so the Money symbol is stable.
  usePreferencesStore.setState({
    visualCardMetric: 'stockHealth',
    lowStockQtyThreshold: 5,
    lowStockGaugePercent: 20,
    baseCurrency: 'GBP',
    locale: 'en-GB',
  });
});
afterEach(cleanup);

describe('DiscreteCardMetric — stock-health branch', () => {
  it('shows "In stock" for a healthy quantity, with no reorder hint', () => {
    render(<DiscreteCardMetric item={makeItem({ quantity: 100 })} />);
    expect(screen.getByText('In stock')).not.toBeNull();
    expect(screen.queryByText(/^reorder /)).toBeNull();
  });

  it('shows "Low stock" and the shortfall reorder hint when at/below the floor', () => {
    // qty 3 ≤ the 5 floor → low; shortfall to the floor is 5 − 3 = 2.
    render(<DiscreteCardMetric item={makeItem({ quantity: 3 })} />);
    expect(screen.getByText('Low stock')).not.toBeNull();
    expect(screen.getByText('reorder 2')).not.toBeNull();
  });

  it('prefers the explicit per-item reorder quantity over the computed shortfall', () => {
    render(<DiscreteCardMetric item={makeItem({ quantity: 3, reorderQty: 40 })} />);
    expect(screen.getByText('Low stock')).not.toBeNull();
    expect(screen.getByText('reorder 40')).not.toBeNull();
  });

  it('shows "Out of stock" when nothing is on hand', () => {
    render(<DiscreteCardMetric item={makeItem({ quantity: 0 })} />);
    expect(screen.getByText('Out of stock')).not.toBeNull();
    // "out" is a distinct band from "low", so no reorder hint is shown here.
    expect(screen.queryByText(/^reorder /)).toBeNull();
  });

  it('honours a per-item reorder point over the global default', () => {
    // qty 100 is healthy against the global floor of 5, but its own floor of 200 makes it low.
    render(<DiscreteCardMetric item={makeItem({ quantity: 100, reorderPoint: 200 })} />);
    expect(screen.getByText('Low stock')).not.toBeNull();
    expect(screen.getByText('reorder 100')).not.toBeNull();
  });
});

describe('DiscreteCardMetric — total-value branch', () => {
  beforeEach(() => usePreferencesStore.setState({ visualCardMetric: 'value' }));

  it('renders the total stock value (unitCost × quantity) with the currency symbol', () => {
    render(<DiscreteCardMetric item={makeItem({ quantity: 4, unitCost: 2.5 })} />);
    // 4 × £2.50 = £10.00; the Money control splits the symbol into its own span, so match on
    // the element's combined text content rather than a single text node.
    const value = screen.getByText('total value').previousElementSibling;
    expect(value?.textContent).toBe('£10.00');
  });

  it('shows an em-dash and "unpriced" when the item has no unit cost', () => {
    render(<DiscreteCardMetric item={makeItem({ quantity: 4, unitCost: null })} />);
    expect(screen.getByText('unpriced')).not.toBeNull();
    expect(screen.getByText('—')).not.toBeNull();
  });
});
