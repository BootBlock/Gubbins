import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Item, ItemBatchPlacement } from '@/db/repositories';
import { ToastProvider } from '@/components/foundry';

// Data hooks are stubbed so the test controls the stock/batch picture directly; the point
// under test is the `batches` capability gate, not the data plumbing.
const placements = [{ locationId: 'loc-1', locationName: 'Shelf A', quantity: 5 }];
const trackedBatches: ItemBatchPlacement[] = [
  {
    locationId: 'loc-1',
    locationName: 'Shelf A',
    batchKey: '["42",null,null]',
    batchNumber: '42',
    lotNumber: null,
    expiryDate: null,
    quantity: 5,
  },
];

vi.mock('../hooks', () => ({
  useItemStock: () => ({ data: placements }),
  useItemBatches: () => ({ data: trackedBatches }),
  useTransferStock: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/features/inventory/queries', () => ({
  useLocations: () => ({ data: { rows: [{ id: 'loc-1', name: 'Shelf A' }] } }),
}));
// The batch gate consults the item's category as well as the device's modules (issue #618),
// reading it from the app-wide category list. This item has no category, so nothing is hidden by
// one and the capability toggle below remains the only thing under test.
vi.mock('@/features/inventory/categories', () => ({
  useCategories: () => ({ data: { rows: [] } }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ date: (n: number) => String(n), calendarDate: (n: number) => String(n) }),
}));

import { StockBreakdown } from './StockBreakdown';
import { useModulesStore } from '@/state/stores/useModulesStore';

const item = { id: 'item-1', locationId: 'loc-1', trackingMode: 'DISCRETE', quantity: 5 } as Item;

function renderBreakdown() {
  return render(
    <ToastProvider>
      <StockBreakdown item={item} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('StockBreakdown — batch detail gating (Phase 6)', () => {
  it('shows the per-lot batch breakdown when Batches is on', () => {
    renderBreakdown();
    // The per-location stock breakdown is always there (it is core inventory)…
    expect(screen.queryByTestId('stock-placement-loc-1')).not.toBeNull();
    // …and the tracked-lot detail nested beneath it shows while Batches is on.
    expect(screen.queryByTestId('stock-batches-loc-1')).not.toBeNull();
  });

  it('hides the per-lot detail when Batches is off, keeping the per-location breakdown', () => {
    useModulesStore.getState().setFeatureIntent('batches', false);
    renderBreakdown();
    // Core per-location stock ledger + quantity remain — only the lot-level facet disappears.
    expect(screen.queryByTestId('stock-placement-loc-1')).not.toBeNull();
    expect(screen.getByTestId('stock-qty-loc-1').textContent).toBe('5');
    expect(screen.queryByTestId('stock-batches-loc-1')).toBeNull();
  });
});
