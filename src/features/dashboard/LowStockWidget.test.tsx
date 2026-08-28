import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { widgetById } from './widgets';

/**
 * The Low Stock widget surfaces incoming ("on order") stock so a covered shortage reads as
 * "handled", *without* changing what counts as low — the alert stays on-hand-based. The
 * low-stock feed and the batched on-order read are both mocked so this exercises only the
 * widget's rendering of the affordance and the de-emphasis of fully-covered rows.
 */
const spies = vi.hoisted(() => ({ lowStock: vi.fn(), lowStockCount: vi.fn(), onOrder: vi.fn() }));

vi.mock('@/features/lifecycle/hooks', () => ({
  useLowStockItems: () => spies.lowStock(),
}));

// The headline figure is the repository's `COUNT(*)`, not the rows in hand (issue #606). Here it
// answers with the length of the mocked feed, which is what a real count would say for a set this
// small — the two are held to agree on real data by `attention-count-parity.test.ts`.
vi.mock('@/features/reports/queries', () => ({
  useLowStockCount: () => ({
    data: spies.lowStockCount() ?? spies.lowStock().data?.rows.length ?? 0,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('@/features/purchasing/queries', () => ({
  useOnOrderQtys: () => spies.onOrder(),
}));

const baseItem: Item = {
  id: 'item-1',
  name: 'Item',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 2,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  reorderPoint: 10,
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
  isUnlimited: false,
};

/** A low DISCRETE item (qty 2, reorder point 10 → shortfall 8) with a distinct name/id. */
const low = (over: Partial<Item> = {}): Item => ({ ...baseItem, ...over });

const LowStockWidget = widgetById('low-stock')!.Component;

function renderWidget() {
  return render(<LowStockWidget />);
}

beforeEach(() => {
  usePreferencesStore.setState({ lowStockQtyThreshold: 0, lowStockGaugePercent: 0 });
  spies.onOrder.mockReturnValue({ data: new Map<string, number>() });
});

afterEach(() => {
  cleanup();
  spies.lowStock.mockReset();
  spies.lowStockCount.mockReset();
  spies.onOrder.mockReset();
});

describe('LowStockWidget — on-order affordance', () => {
  it('shows a "N on order" affordance for a low item with incoming stock', () => {
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Widget A' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 4]]) });

    renderWidget();
    const badge = screen.getByTestId('low-stock-on-order');
    expect(badge).toHaveTextContent('4 on order');
  });

  it('omits the affordance for a low item with nothing on order', () => {
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Widget A' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map<string, number>() });

    renderWidget();
    expect(screen.queryByTestId('low-stock-on-order')).toBeNull();
    expect(screen.getByText('Widget A')).toBeInTheDocument();
  });

  it('de-emphasises a row fully covered by incoming stock, but keeps it listed and counted', () => {
    // Shortfall is 8 (10 − 2). onOrder 8 fully covers it → the row is dimmed but stays.
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Covered Co' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 8]]) });

    renderWidget();
    const label = screen.getByText('Covered Co');
    // The row remains in the list (the low-stock threshold is untouched by netting)…
    expect(label).toBeInTheDocument();
    // …but is visually de-emphasised (opacity utility on the row container).
    const row = label.closest('div');
    expect(row?.className).toContain('opacity-55');
    // …and still carries the on-order affordance.
    expect(within(row!).getByTestId('low-stock-on-order')).toHaveTextContent('8 on order');
  });

  it('does not de-emphasise a row only partially covered by incoming stock', () => {
    // Shortfall 8, only 3 inbound → still short, so no dimming.
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Partial Co' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 3]]) });

    renderWidget();
    const row = screen.getByText('Partial Co').closest('div');
    expect(row?.className).not.toContain('opacity-55');
    expect(within(row!).getByTestId('low-stock-on-order')).toHaveTextContent('3 on order');
  });

  it('keeps the low-stock count on-hand-based even when every row is fully on order', () => {
    // Three low items, all fully covered by incoming stock — the count still reads 3
    // (the alert never re-nets against on-order), and all three stay listed.
    const rows = [
      low({ id: 'a', name: 'Aaa' }),
      low({ id: 'b', name: 'Bbb' }),
      low({ id: 'c', name: 'Ccc' }),
    ];
    spies.lowStock.mockReturnValue({ data: { rows }, isPending: false, isError: false });
    spies.onOrder.mockReturnValue({
      data: new Map([
        ['a', 8],
        ['b', 8],
        ['c', 8],
      ]),
    });

    renderWidget();
    // The headline count is the number of low items, unaffected by on-order coverage.
    expect(screen.getByText('3')).toBeInTheDocument();
    for (const name of ['Aaa', 'Bbb', 'Ccc']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('renders healthy state (no on-order query fired) when nothing is low', () => {
    spies.lowStock.mockReturnValue({ data: { rows: [] }, isPending: false, isError: false });
    spies.onOrder.mockReturnValue({ data: undefined });

    renderWidget();
    expect(screen.getByText('Stock levels healthy.')).toBeInTheDocument();
    expect(screen.queryByTestId('low-stock-on-order')).toBeNull();
  });
});
