import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * Behaviour tests for the {@link ScannerOverlay} Discrete result card's quick actions (the
 * scan→act loop). The scanner's pure seams — payload parsing, the state machine, the batch
 * runner — are covered by `scanner.test.ts`; this pins the *card's* contract: which controls
 * a scanned item offers per tracking mode, and that each routes through the right hook.
 *
 * Per the component-test conventions every hook the overlay touches is mocked (a new hook →
 * extend the mock), the camera/decoder is neutered (`useScanner`) and a scan is driven through
 * the always-available manual-entry seam rather than a faked camera frame. Fixtures are synthetic.
 */

const UUID = '00000000-0000-4000-8000-0000000000ab';

const adjustMutate = vi.fn();
const moveMutateAsync = vi.fn().mockResolvedValue(undefined);
const checkoutMutateAsync = vi.fn().mockResolvedValue(undefined);

// getById drives what the scanned code resolves to; each test sets `scanResult` first.
let scanResult: Item | null = null;

vi.mock('../useScanner', () => ({ useScanner: () => {} }));
vi.mock('../feedback', () => ({
  ScanFeedback: class {
    prime() {}
    confirm() {}
    dispose() {}
  },
}));
vi.mock('@/features/contacts/components/CheckoutDialog', () => ({ CheckoutDialog: () => null }));
vi.mock('@/features/contacts/contacts', () => ({
  useCheckoutItem: () => ({ mutateAsync: checkoutMutateAsync, isPending: false }),
}));
vi.mock('@/features/inventory/mutations', () => ({
  useMoveItem: () => ({ mutateAsync: moveMutateAsync, isPending: false }),
  useAdjustQuantity: () => ({ mutate: adjustMutate }),
}));
vi.mock('@/features/inventory/queries', () => ({
  // The card falls back to the scan snapshot until this resolves; leaving it empty keeps the
  // test driving the snapshot from `getById` (below) without a QueryClient.
  useItem: () => ({ data: undefined }),
  useLocations: () => ({ data: { rows: [{ id: 'loc-2', name: 'Shelf B' }] } }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ quantity: (n: number) => String(n) }),
}));
vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getItemRepository: () => ({
    getById: () => Promise.resolve(scanResult),
    getByBarcode: () => Promise.resolve(null),
  }),
}));

import { ScannerOverlay } from './ScannerOverlay';

const baseItem: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 10,
  isUnlimited: false,
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

/** Render the overlay, scan one item via the manual-entry seam, and await its result card. */
async function scan(item: Item, props: Partial<React.ComponentProps<typeof ScannerOverlay>> = {}) {
  scanResult = item;
  render(<ScannerOverlay open onClose={vi.fn()} {...props} />);
  fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value: UUID } });
  fireEvent.click(screen.getByTestId('scanner-manual-submit'));
  await screen.findByTestId('scanner-discrete-result');
}

beforeEach(() => {
  scanResult = null;
  adjustMutate.mockReset();
  moveMutateAsync.mockReset().mockResolvedValue(undefined);
  checkoutMutateAsync.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ScannerOverlay — Discrete card ± quantity', () => {
  it('shows the ± stepper for an active DISCRETE item and adjusts by the right delta', async () => {
    await scan(baseItem);
    expect(screen.queryByTestId('scanner-adjust-quantity')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Increase quantity'));
    expect(adjustMutate).toHaveBeenCalledWith({ id: 'item-1', delta: 1 });

    fireEvent.click(screen.getByLabelText('Decrease quantity'));
    expect(adjustMutate).toHaveBeenCalledWith({ id: 'item-1', delta: -1 });
  });

  it.each([
    ['a gauge item', { ...baseItem, trackingMode: 'CONSUMABLE_GAUGE' as const }],
    ['a serialised item', { ...baseItem, trackingMode: 'SERIALISED' as const, serialNo: 1 }],
    ['an untracked item', { ...baseItem, trackingMode: 'UNTRACKED' as const }],
    ['an unlimited source', { ...baseItem, isUnlimited: true }],
  ])('does not show ± for %s', async (_label, item) => {
    await scan(item);
    expect(screen.queryByTestId('scanner-adjust-quantity')).toBeNull();
  });
});

describe('ScannerOverlay — Discrete card Move', () => {
  it('moves the scanned item to the chosen location via useMoveItem', async () => {
    await scan(baseItem);
    fireEvent.click(screen.getByRole('combobox', { name: 'Move to location' }));
    fireEvent.click(screen.getByRole('option', { name: 'Shelf B' }));
    fireEvent.click(screen.getByTestId('scanner-move-single'));

    await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledWith({ id: 'item-1', locationId: 'loc-2' }));
  });
});

describe('ScannerOverlay — Discrete card View details', () => {
  it('hands the scanned item back to onViewItem when wired', async () => {
    const onViewItem = vi.fn();
    await scan(baseItem, { onViewItem });
    fireEvent.click(screen.getByTestId('scanner-view-item'));
    expect(onViewItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }));
  });

  it('hides View details when the parent does not wire the handoff', async () => {
    await scan(baseItem);
    expect(screen.queryByTestId('scanner-view-item')).toBeNull();
  });
});
