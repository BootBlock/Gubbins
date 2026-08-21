import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';

// The action row mounts every per-item dialog (closed); stub them to inert components so the
// test exercises only the action buttons, not each dialog's own hooks.
vi.mock('@/features/contacts/components/CheckoutDialog', () => ({ CheckoutDialog: () => null }));
vi.mock('@/features/projects/components/AddItemToProjectDialog', () => ({
  AddItemToProjectDialog: () => null,
}));
vi.mock('@/features/sales/components/SellDialog', () => ({ SellDialog: () => null }));
vi.mock('@/features/sales/components/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('./GaugeAdjustDialog', () => ({ GaugeAdjustDialog: () => null }));
vi.mock('./ItemDetailDialog', () => ({ ItemDetailDialog: () => null }));
vi.mock('./MoveItemDialog', () => ({ MoveItemDialog: () => null }));
vi.mock('./QrCodeDialog', () => ({ QrCodeDialog: () => null }));
const spies = vi.hoisted(() => ({ update: vi.fn(), softDelete: vi.fn() }));
vi.mock('../mutations', () => ({
  useSoftDeleteItem: () => ({ mutate: spies.softDelete }),
  // The remove/restore confirmations offer an Undo (issue #131), so the row reads this hook too.
  useUndoItemChanges: () => ({ mutate: vi.fn() }),
  useRestoreItem: () => ({ mutate: vi.fn() }),
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
  // Read by the "Count by weight" dialog (issue #101), which mounts alongside the menu.
  useAdjustQuantity: () => ({ mutate: vi.fn(), isPending: false }),
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
  spies.update.mockReset();
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

describe('ItemActions — Untracked loan escape hatch (B5)', () => {
  const untracked: Item = { ...item, trackingMode: 'UNTRACKED', quantity: 0 };

  it('replaces live "Loan out…" with the convert hint on an Untracked item', () => {
    render(<ItemActions item={untracked} locations={[]} />);
    openMoreMenu();
    // No live loan action for an Untracked item — checkout rejects it by design…
    expect(screen.queryByRole('menuitem', { name: /^Loan out/ })).toBeNull();
    // …but the convert-to-Bulk escape hatch is offered in its place.
    expect(screen.queryByRole('menuitem', { name: /Convert to Bulk to loan out/ })).not.toBeNull();
  });

  it('does not show the convert hint on a DISCRETE item (it can be loaned directly)', () => {
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Convert to Bulk to loan out/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Loan out/ })).not.toBeNull();
  });

  it('does not show the convert hint on a SERIALISED item', () => {
    render(<ItemActions item={{ ...item, trackingMode: 'SERIALISED', quantity: 1 }} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Convert to Bulk to loan out/ })).toBeNull();
  });

  it('hides the convert hint when Contacts is off (the way in disappears entirely)', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    render(<ItemActions item={untracked} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Convert to Bulk to loan out/ })).toBeNull();
  });

  it('invokes the tracking-mode change to DISCRETE when the convert CTA is chosen', () => {
    render(<ItemActions item={untracked} locations={[]} />);
    openMoreMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Convert to Bulk to loan out/ }));
    expect(spies.update).toHaveBeenCalledWith({
      id: untracked.id,
      input: { trackingMode: 'DISCRETE' },
    });
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

describe('ItemActions — add-to-project gating (Projects module)', () => {
  it('offers "Add to project" on an active item when Projects is on', () => {
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Add to project/ })).not.toBeNull();
  });

  it('hides "Add to project" when the Projects module is off', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<ItemActions item={item} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Add to project/ })).toBeNull();
    // Move stays — it's unrelated to the Projects module, so the menu is never empty.
    expect(screen.queryByRole('menuitem', { name: /Move/ })).not.toBeNull();
  });

  it('does not offer "Add to project" for a removed (inactive) item', () => {
    render(<ItemActions item={{ ...item, isActive: false }} locations={[]} />);
    openMoreMenu();
    expect(screen.queryByRole('menuitem', { name: /Add to project/ })).toBeNull();
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
