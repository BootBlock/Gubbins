import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { GaugeConfigEditor } from './GaugeConfigEditor';

const spies = vi.hoisted(() => ({ reconfigure: vi.fn() }));

vi.mock('../mutations', () => ({
  useReconfigureGauge: () => ({ mutate: spies.reconfigure, isPending: false }),
}));

vi.mock('../queries', () => ({
  useFieldSuggestions: () => ({ data: ['g', 'ml', 'm'] }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ measure: (n: number, unit: string) => `${n}${unit}` }),
}));

const baseItem: Item = {
  id: 'item-1',
  name: 'Cat6 drum',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'CONSUMABLE_GAUGE',
  quantity: 0,
  serialNo: null,
  mpn: null,
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
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: {
    unitOfMeasure: 'm',
    grossCapacity: 100,
    tareWeight: 2,
    currentNetValue: 85.5,
    percentageRemaining: 85.5,
    currentGrossWeight: 87.5,
    attritionPercent: null,
  },
  operationalMetadata: null,
};

const item = (over: Partial<Item> = {}): Item => ({ ...baseItem, ...over });

const save = () => screen.getByTestId('gauge-config-save');
const capacity = () => screen.getByTestId('gauge-config-capacity');
const tare = () => screen.getByTestId('gauge-config-tare');

beforeEach(() => spies.reconfigure.mockClear());
afterEach(cleanup);

describe('GaugeConfigEditor (issue #69)', () => {
  it('seeds the fields from the item’s saved configuration', () => {
    render(<GaugeConfigEditor item={item()} />);
    // A `type="number"` Foundry Input is the calculator-enabled control (issue #93), so it
    // is a text field under the hood and its value reads back as a string.
    expect(capacity()).toHaveValue('100');
    expect(tare()).toHaveValue('2');
    expect(save()).toBeDisabled();
    expect(save()).toHaveTextContent('Saved');
  });

  it('saves an edited capacity as a gauge reconfiguration', () => {
    render(<GaugeConfigEditor item={item()} />);
    fireEvent.change(capacity(), { target: { value: '250' } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(spies.reconfigure).toHaveBeenCalledWith({
      id: 'item-1',
      change: { unitOfMeasure: 'm', grossCapacity: 250, tareWeight: 2, attritionPercent: null },
    });
  });

  it('refuses to save a capacity of zero or below', () => {
    render(<GaugeConfigEditor item={item()} />);
    fireEvent.change(capacity(), { target: { value: '0' } });
    expect(save()).toBeDisabled();
    expect(screen.getByText('Capacity must be greater than zero.')).toBeInTheDocument();
  });

  it('refuses to save a negative tare', () => {
    render(<GaugeConfigEditor item={item()} />);
    fireEvent.change(tare(), { target: { value: '-1' } });
    expect(save()).toBeDisabled();
    expect(screen.getByText('Tare must be zero or more.')).toBeInTheDocument();
  });

  it('warns how much would be discarded before shrinking below the current level', () => {
    render(<GaugeConfigEditor item={item()} />);
    // The drum holds 85.5 m; a 50 m capacity would displace 35.5 m of it.
    fireEvent.change(capacity(), { target: { value: '50' } });
    expect(screen.getByTestId('gauge-config-spill')).toHaveTextContent('35.5m will be discarded');
    // Still savable — it is a legitimate correction, just one worth warning about.
    expect(save()).toBeEnabled();
  });

  it('shows no spill warning when the capacity still covers the current level', () => {
    render(<GaugeConfigEditor item={item()} />);
    fireEvent.change(capacity(), { target: { value: '90' } });
    expect(screen.queryByTestId('gauge-config-spill')).not.toBeInTheDocument();
  });

  it('explains itself rather than rendering fields for a non-gauge item', () => {
    render(<GaugeConfigEditor item={item({ trackingMode: 'DISCRETE', gauge: null })} />);
    expect(screen.queryByTestId('gauge-config-save')).not.toBeInTheDocument();
    expect(screen.getByText(/only consumable items measured on a gauge/i)).toBeInTheDocument();
  });
});
