import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';

// The action row mounts every per-item dialog (closed); stub them to inert components so the
// test exercises only the action buttons, not each dialog's own hooks.
vi.mock('@/features/contacts/components/CheckoutDialog', () => ({ CheckoutDialog: () => null }));
vi.mock('@/features/sales/components/SellDialog', () => ({ SellDialog: () => null }));
vi.mock('@/features/sales/components/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('./GaugeAdjustDialog', () => ({ GaugeAdjustDialog: () => null }));
vi.mock('./ItemDetailDialog', () => ({ ItemDetailDialog: () => null }));
vi.mock('./MoveItemDialog', () => ({ MoveItemDialog: () => null }));
vi.mock('./QrCodeDialog', () => ({ QrCodeDialog: () => null }));
vi.mock('../mutations', () => ({
  useSoftDeleteItem: () => ({ mutate: vi.fn() }),
  useRestoreItem: () => ({ mutate: vi.fn() }),
}));

import { ItemActions } from './ItemActions';
import { useModulesStore } from '@/state/stores/useModulesStore';

const item: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 10,
  serialNo: null,
  mpn: 'NE555P',
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

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

/** Open the "More actions" overflow menu so its rows (move / loan / sell / write off) render. */
function openMoreMenu() {
  fireEvent.click(screen.getByLabelText('More actions'));
}

describe('ItemActions — checkout gating (Phase 6)', () => {
  it('offers Loan out on an eligible item when Contacts is on', () => {
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Loan out/ })).not.toBeNull();
  });

  it('hides Loan out when Contacts is off, leaving the other actions intact', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Loan out/ })).toBeNull();
    // The record + move actions (unrelated to the Contacts module) remain in the menu; Move
    // is always offered, so the overflow menu is never empty.
    expect(screen.queryByRole('menuitem', { name: /Edit details/ })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Print label/ })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Move/ })).not.toBeNull();
  });
});

describe('ItemActions — record actions live in the overflow menu', () => {
  it('exposes edit + label as focusable menu rows, not standalone buttons', () => {
    render(<ItemActions item={item} locations={[]} />);
    // Edit / label no longer take a slot on the compact footer row…
    expect(screen.queryByLabelText('Item details')).toBeNull();
    expect(screen.queryByLabelText('Item label')).toBeNull();
    // …they are reachable through the overflow menu instead (keyboard parity for the
    // `cardClickAction` body-click shortcut).
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Edit details/ })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Print label/ })).not.toBeNull();
  });
});

describe('ItemActions — sell/write-off gating (Sales & disposals)', () => {
  it('offers Sell and Write off on an active DISCRETE item when Sales is on', () => {
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Sell/ })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Write off/ })).not.toBeNull();
  });

  it('hides Sell and Write off when the Sales module is off', () => {
    useModulesStore.getState().setFeatureIntent('sales', false);
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Sell/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Write off/ })).toBeNull();
  });

  it('does not offer Sell for a non-DISCRETE item', () => {
    render(<ItemActions item={{ ...item, trackingMode: 'SERIALISED', quantity: 1 }} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Sell/ })).toBeNull();
  });
});
