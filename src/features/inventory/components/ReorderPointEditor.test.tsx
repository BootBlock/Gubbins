import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ReorderPointEditor } from './ReorderPointEditor';

const spies = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../mutations', () => ({
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
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

beforeEach(() => {
  // The global blanket defaults to off (0); keep it deterministic across tests.
  usePreferencesStore.setState({ lowStockQtyThreshold: 0, lowStockGaugePercent: 0 });
});

afterEach(() => {
  cleanup();
  spies.update.mockReset();
});

describe('ReorderPointEditor — opt-in toggle', () => {
  it('starts off for an unconfigured item, with the trigger hidden and Save pristine', () => {
    render(<ReorderPointEditor item={discrete()} />);
    const toggle = screen.getByTestId('reorder-alert-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId('reorder-point-input')).toBeNull();
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('reveals the trigger pre-seeded with the suggestion when switched on', () => {
    render(<ReorderPointEditor item={discrete()} />);
    fireEvent.click(screen.getByTestId('reorder-alert-toggle'));
    expect(screen.getByTestId('reorder-point-input')).toHaveValue(5);
    // Now dirty (a value would be written), so Save is enabled.
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', false);
  });

  it('saves the per-item reorder point (and top-up) once opted in', () => {
    render(<ReorderPointEditor item={discrete()} />);
    fireEvent.click(screen.getByTestId('reorder-alert-toggle'));
    fireEvent.change(screen.getByTestId('reorder-point-input'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('reorder-qty-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderPoint: 20, reorderQty: 50 },
    });
  });

  it('starts on (with the value shown) for an already-watched item, pristine', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20, reorderQty: 50 })} />);
    const toggle = screen.getByTestId('reorder-alert-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId('reorder-point-input')).toHaveValue(20);
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('clears the override when switched off', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 20, reorderQty: 50 })} />);
    fireEvent.click(screen.getByTestId('reorder-alert-toggle')); // turn off
    expect(screen.queryByTestId('reorder-point-input')).toBeNull();
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderPoint: null, reorderQty: null },
    });
  });

  it('treats a stored 0 (exempt) as off without a spurious unsaved change', () => {
    render(<ReorderPointEditor item={discrete({ reorderPoint: 0 })} />);
    expect((screen.getByTestId('reorder-alert-toggle') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('reorder-point-save')).toHaveProperty('disabled', true);
  });

  it('drives the gauge variant: seeds a percentage and saves it', () => {
    render(<ReorderPointEditor item={gauge()} />);
    expect(screen.queryByTestId('reorder-gauge-input')).toBeNull();
    fireEvent.click(screen.getByTestId('reorder-alert-toggle'));
    expect(screen.getByTestId('reorder-gauge-input')).toHaveValue(15);
    fireEvent.click(screen.getByTestId('reorder-point-save'));
    expect(spies.update).toHaveBeenCalledWith({
      id: 'item-1',
      input: { reorderGaugePercent: 15 },
    });
  });

  it('shows a "bulk stock only" note for serialised items (no toggle)', () => {
    render(<ReorderPointEditor item={discrete({ trackingMode: 'SERIALISED' })} />);
    expect(screen.queryByTestId('reorder-alert-toggle')).toBeNull();
    expect(screen.getByText(/serialised single assets/i)).toBeInTheDocument();
  });
});
