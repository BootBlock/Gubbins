import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ReorderPointEditor } from './ReorderPointEditor';

const spies = vi.hoisted(() => ({ update: vi.fn(), onOrder: vi.fn(() => 0) }));

vi.mock('../mutations', () => ({
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
}));

vi.mock('@/features/purchasing/queries', () => ({
  useOnOrderQty: () => ({ data: spies.onOrder() }),
}));

const baseItem: Item = {
  id: 'item-1',
  name: 'M3 screws',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 100,
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
  gauge: null,
  operationalMetadata: null,
};

const discrete = (over: Partial<Item> = {}): Item => ({ ...baseItem, ...over });
const gauge = (over: Partial<Item> = {}): Item => ({
  ...baseItem,
  trackingMode: 'CONSUMABLE_GAUGE',
  ...over,
});

const policy = (name: 'default' | 'custom' | 'never') => screen.getByTestId(`low-stock-policy-${name}`);

beforeEach(() => {
  // The global blanket defaults to off (0); keep it deterministic across tests.
  usePreferencesStore.setState({ lowStockQtyThreshold: 0, lowStockGaugePercent: 0 });
});

afterEach(() => {
  cleanup();
  spies.update.mockReset();
  spies.onOrder.mockReset();
  spies.onOrder.mockReturnValue(0);
});

describe('ReorderPointEditor — policy picker', () => {
  it('starts on "Default" for an unconfigured item, trigger hidden, Save pristine', () => {
    render(<ReorderPointEditor item={discrete()} />);
    expect(policy('default')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('reorder-point-input')).toBeNull();
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('reveals the trigger pre-seeded with the suggestion when "Custom" is chosen', () => {
    render(<ReorderPointEditor item={discrete()} />);
    fireEvent.click(policy('custom'));
    expect(screen.getByTestId('reorder-point-input')).toHaveValue(5);
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', false);
  });

  it('saves the per-item reorder point (and top-up) for the Custom policy', () => {
    render(<ReorderPointEditor item={discrete()} />);
    fireEvent.click(policy('custom'));
    fireEvent.change(screen.getByTestId('reorder-point-input'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('reorder-qty-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderPoint: 20, reorderQty: 50 },
    });
  });

  it('saves a hard exemption (reorderPoint 0) for the "Never" policy', () => {
    render(<ReorderPointEditor item={discrete()} />);
    fireEvent.click(policy('never'));
    expect(screen.queryByTestId('reorder-point-input')).toBeNull();
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderPoint: 0, reorderQty: null },
    });
  });

  it('starts on "Custom" with the value shown for an already-watched item, pristine', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20, reorderQty: 50 })} />);
    expect(policy('custom')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('reorder-point-input')).toHaveValue(20);
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('starts on "Never" and stays pristine for an already-exempt item', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 0 })} />);
    expect(policy('never')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('clears the override when switched back to "Default"', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20, reorderQty: 50 })} />);
    fireEvent.click(policy('default'));
    expect(screen.queryByTestId('reorder-point-input')).toBeNull();
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderPoint: null, reorderQty: null },
    });
  });

  it('drives the gauge variant: Custom seeds a percentage and saves it', () => {
    render(<ReorderPointEditor item={gauge()} />);
    expect(screen.queryByTestId('reorder-gauge-input')).toBeNull();
    fireEvent.click(policy('custom'));
    expect(screen.getByTestId('reorder-gauge-input')).toHaveValue(15);
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderGaugePercent: 15 },
    });
  });

  it('exempts a gauge item (0) for the "Never" policy', () => {
    render(<ReorderPointEditor item={gauge()} />);
    fireEvent.click(policy('never'));
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderGaugePercent: 0 },
    });
  });

  it('shows a "bulk stock only" note for serialised items (no picker)', () => {
    render(<ReorderPointEditor item={discrete({ trackingMode: 'SERIALISED' })} />);
    expect(screen.queryByTestId('low-stock-policy-custom')).toBeNull();
    expect(screen.getByText(/serialised single assets/i)).toBeInTheDocument();
  });
});

describe('ReorderPointEditor — on-order visibility', () => {
  it('surfaces the on-order quantity beside the reorder point when stock is inbound', () => {
    spies.onOrder.mockReturnValue(12);
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20 })} />);
    const onOrder = screen.getByTestId('reorder-on-order');
    expect(onOrder).toBeInTheDocument();
    expect(onOrder).toHaveTextContent('12 on order');
  });

  it('shows nothing when no stock is on order', () => {
    spies.onOrder.mockReturnValue(0);
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20 })} />);
    expect(screen.queryByTestId('reorder-on-order')).toBeNull();
  });
});
