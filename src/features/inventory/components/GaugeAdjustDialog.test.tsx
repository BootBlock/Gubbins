import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';

const spies = vi.hoisted(() => ({ adjust: vi.fn() }));
vi.mock('../mutations', () => ({
  useAdjustGauge: () => ({ mutate: spies.adjust, isPending: false }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ measure: (value: number, unit: string) => `${value}${unit}` }),
}));

import { GaugeAdjustDialog } from './GaugeAdjustDialog';

// A half-used 1 kg spool: 800 g of usable material left in a 1000 g capacity, 250 g tare.
const item: Item = {
  id: 'item-1',
  name: 'PLA filament',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'CONSUMABLE_GAUGE',
  quantity: 0,
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
  gauge: {
    unitOfMeasure: 'g',
    grossCapacity: 1000,
    tareWeight: 250,
    currentNetValue: 800,
    percentageRemaining: 80,
    currentGrossWeight: 1050,
  },
  operationalMetadata: null,
};

beforeEach(() => spies.adjust.mockReset());
afterEach(cleanup);

describe('GaugeAdjustDialog — Estimate quick-set (issue #95)', () => {
  it('lets the user pick a fill level and applies the relative delta', () => {
    render(<GaugeAdjustDialog item={item} open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('gauge-mode-estimate'));

    // No level chosen yet — nothing to apply.
    const apply = screen.getByTestId('gauge-apply');
    expect(apply).toBeDisabled();

    // Pick "Half" → target 500 g, so the stored delta is 500 − 800 = −300 g.
    fireEvent.click(screen.getByTestId('gauge-level-half'));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(spies.adjust).toHaveBeenCalledTimes(1);
    const [{ id, adjustment }] = spies.adjust.mock.calls[0]!;
    expect(id).toBe('item-1');
    expect(adjustment.delta).toBe(-300);
    expect(adjustment.note).toBe('Estimated Half (~50%, now 500g)');
  });

  it('keeps Apply disabled when the chosen level matches the current fill', () => {
    // A brand-new, full spool sitting at capacity.
    const fullItem: Item = {
      ...item,
      gauge: { ...item.gauge!, currentNetValue: 1000, percentageRemaining: 100 },
    };
    render(<GaugeAdjustDialog item={fullItem} open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('gauge-mode-estimate'));

    // "Half" (50% → 500 g) is a real change, so Apply enables…
    fireEvent.click(screen.getByTestId('gauge-level-half'));
    expect(screen.getByTestId('gauge-apply')).toBeEnabled();

    // …but "Full" (100% → 1000 g) equals the current net, a no-op, so Apply disables.
    fireEvent.click(screen.getByTestId('gauge-level-full'));
    expect(screen.getByTestId('gauge-apply')).toBeDisabled();
  });
});
