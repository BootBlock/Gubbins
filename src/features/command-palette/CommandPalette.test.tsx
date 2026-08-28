import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item } from '@/db/repositories';

// Router: only useNavigate is needed by the palette.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

// Quick-action hook spies — asserted by the find→act tests below.
const adjustMutate = vi.fn();
const moveMutateAsync = vi.fn().mockResolvedValue(undefined);
const checkoutMutateAsync = vi.fn().mockResolvedValue(undefined);
// The full record the quick-actions panel loads (via useItem) for the acted-on item; each
// test sets it to a fixture whose tracking mode drives which controls are shown.
let actingItem: Item | null = null;

// Item search returns a fixed set of best-match rows plus how many matched altogether; the palette
// only reads id + name for the list. `searchTotal` is what the "see all N" disclosure row keys off,
// so each test can set it to a number larger than the rows to exercise the capped case.
// The quick-actions panel then loads the full record via useItem, and its location picker
// via useLocations.
let searchRows: { id: string; name: string }[] = [];
let searchTotal = 0;
vi.mock('@/features/inventory/queries', () => ({
  useItemRelevanceSearch: () => ({
    data: { rows: searchRows, total: searchTotal },
    isPending: false,
  }),
  useItem: () => ({ data: actingItem ?? undefined }),
  useLocations: () => ({ data: { rows: [{ id: 'loc-2', name: 'Shelf B' }] } }),
}));
vi.mock('@/features/inventory/mutations', () => ({
  useMoveItem: () => ({ mutateAsync: moveMutateAsync, isPending: false }),
  useAdjustQuantity: () => ({ mutate: adjustMutate }),
}));
vi.mock('@/features/contacts/contacts', () => ({
  useCheckoutItem: () => ({ mutateAsync: checkoutMutateAsync, isPending: false }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ quantity: (n: number) => String(n) }),
}));

/** Synthetic full item record the panel adapts to; per-test overrides drive the branches. */
const baseItem: Item = {
  id: 'i1',
  name: '10k resistor',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 10,
  isUnlimited: false,
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

import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from './useCommandPaletteStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useModulesStore } from '@/state/stores/useModulesStore';

beforeEach(() => {
  navigateMock.mockClear();
  adjustMutate.mockReset();
  moveMutateAsync.mockReset().mockResolvedValue(undefined);
  checkoutMutateAsync.mockReset().mockResolvedValue(undefined);
  actingItem = { ...baseItem };
  searchRows = [
    { id: 'i1', name: '10k resistor' },
    { id: 'i2', name: '220 ohm resistor' },
  ];
  searchTotal = searchRows.length;
  usePreferencesStore.setState({ dashboardCommandPalette: true });
  useCommandPaletteStore.setState({ open: false });
  useInventoryEntry.setState({ pendingSearch: null, pendingIntent: null });
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('CommandPalette', () => {
  it('renders nothing when the feature is disabled', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('renders nothing while closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('shows live results once a query is typed', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
    const results = await screen.findAllByTestId('command-palette-result');
    expect(results).toHaveLength(2);
    expect(results[0].textContent).toContain('10k resistor');
  });

  it('selecting a result hands the name to inventory and navigates there', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useInventoryEntry.getState().pendingSearch).toBe('10k resistor');
    expect(navigateMock).toHaveBeenCalledWith({ to: '/inventory' });
    // The palette closes itself on select.
    await waitFor(() => expect(screen.queryByTestId('command-palette-input')).toBeNull());
  });

  it('shows a clear button only when there is text, and clearing empties the box', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input') as HTMLInputElement;
    expect(screen.queryByTestId('command-palette-clear')).toBeNull();
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.click(screen.getByTestId('command-palette-clear'));
    expect(input.value).toBe('');
    expect(screen.queryByTestId('command-palette-clear')).toBeNull();
    expect(screen.queryAllByTestId('command-palette-result')).toHaveLength(0);
  });

  it('arrow keys move the active result before Enter selects it', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useInventoryEntry.getState().pendingSearch).toBe('220 ohm resistor');
  });

  it('scrolls the newly highlighted row into view, including on wrap-around (issue #450)', async () => {
    // jsdom stubs scrollIntoView as a no-op; spy on it to prove the wrapped-to selection is
    // asked to reveal itself so the user can always see what's highlighted.
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    scrollSpy.mockClear();
    // ArrowUp from the first row wraps to the last — the row that was previously off-screen.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    scrollSpy.mockRestore();
  });

  // Issue #629 — the palette shows a fixed few rows out of however many matched, so it has to say
  // when it is showing a subset. Silence there reads as "these are all the matches there are".
  describe('disclosing the matches it cannot show', () => {
    it('offers no extra row when every match is already on screen', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
      await screen.findAllByTestId('command-palette-result');
      expect(screen.queryByTestId('command-palette-see-all')).toBeNull();
    });

    it('gives up no room at the boundary — a full list with nothing beyond it stays full', async () => {
      searchRows = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, name: `resistor ${i}` }));
      searchTotal = 8;
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
      const results = await screen.findAllByTestId('command-palette-result');
      expect(results).toHaveLength(8);
      expect(screen.queryByTestId('command-palette-see-all')).toBeNull();
    });

    it('caps the rows shown and says how many matched altogether', async () => {
      searchRows = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, name: `resistor ${i}` }));
      searchTotal = 240;
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
      const results = await screen.findAllByTestId('command-palette-result');
      // Seven items plus the disclosure row: the list is a fixed-height scroller, so the row has
      // to be *on screen* to disclose anything — a ninth row past the bottom would not be.
      expect(results).toHaveLength(7);
      expect(screen.getByTestId('command-palette-see-all').textContent).toContain(
        'See all 240 matches in Inventory',
      );
    });

    it('hands the query — not an item name — to Inventory when the disclosure row is chosen', async () => {
      searchRows = [{ id: 'i1', name: '10k resistor' }];
      searchTotal = 240;
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: 'resistor' } });
      await screen.findByTestId('command-palette-see-all');
      // One row of results, so ArrowDown lands on the disclosure row.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(useInventoryEntry.getState().pendingSearch).toBe('resistor');
      expect(navigateMock).toHaveBeenCalledWith({ to: '/inventory' });
    });
  });

  it('always shows the usage help, including the > hint', () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const help = screen.getByTestId('command-palette-help');
    expect(help.textContent).toContain('jump to a screen');
  });

  describe('screen-jump mode (> prefix)', () => {
    it('lists every screen when the query is just ">"', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '>' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens.length).toBeGreaterThan(1);
      expect(screens.map((s) => s.textContent).join('|')).toContain('Sync');
      // No item results are shown in screen mode.
      expect(screen.queryByTestId('command-palette-result')).toBeNull();
    });

    it('fuzzily filters screens and navigates to the chosen route on Enter', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: '>sync' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens[0].textContent).toContain('Sync');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(navigateMock).toHaveBeenCalledWith({ to: '/sync' });
      // Screen jump must not touch the inventory search intent.
      expect(useInventoryEntry.getState().pendingSearch).toBeNull();
    });

    it('shows an empty state when no screen matches', () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), {
        target: { value: '>zzzzz' },
      });
      expect(screen.queryAllByTestId('command-palette-screen')).toHaveLength(0);
      expect(screen.getByText(/No screens match/)).toBeTruthy();
    });

    it('surfaces the Home Assistant setup guide and navigates to it', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: '>assistant' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens[0].textContent).toContain('Home Assistant');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(navigateMock).toHaveBeenCalledWith({ to: '/home-assistant' });
    });

    it('omits a screen whose feature is switched off', () => {
      useModulesStore.getState().setFeatureIntent('projects', false);
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '>' } });
      const labels = screen.getAllByTestId('command-palette-screen').map((s) => s.textContent);
      expect(labels.some((l) => l?.includes('Projects'))).toBe(false);
      // Core screens remain jumpable.
      expect(labels.some((l) => l?.includes('Inventory'))).toBe(true);
      expect(labels.some((l) => l?.includes('Settings'))).toBe(true);
    });

    it('drops a disabled feature and its dependents together (contacts ⇒ purchase orders, bookings)', () => {
      useModulesStore.getState().setFeatureIntent('contacts', false);
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '>' } });
      const labels = screen.getAllByTestId('command-palette-screen').map((s) => s.textContent);
      expect(labels.some((l) => l?.includes('Contacts'))).toBe(false);
      expect(labels.some((l) => l?.includes('Purchase orders'))).toBe(false);
      expect(labels.some((l) => l?.includes('Bookings'))).toBe(false);
    });

    it('still searches items when a feature is off — item search is core inventory', async () => {
      useModulesStore.getState().applyPreset('minimal');
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
      const results = await screen.findAllByTestId('command-palette-result');
      expect(results).toHaveLength(2);
    });

    it('jumps to the off-nav Catalogue sub-screen', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: '>catalogue' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens[0].textContent).toContain('Catalogue');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(navigateMock).toHaveBeenCalledWith({ to: '/catalogue' });
    });

    it('jumps to the off-nav Insurance schedule sub-screen', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: '>insurance' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens[0].textContent).toContain('Insurance schedule');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(navigateMock).toHaveBeenCalledWith({ to: '/insurance-schedule' });
    });

    it('hides the Reports sub-screens when the Reports module is off', () => {
      useModulesStore.getState().setFeatureIntent('reports', false);
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '>' } });
      const labels = screen.getAllByTestId('command-palette-screen').map((s) => s.textContent);
      expect(labels.some((l) => l?.includes('Reports'))).toBe(false);
      expect(labels.some((l) => l?.includes('Catalogue'))).toBe(false);
      expect(labels.some((l) => l?.includes('Insurance schedule'))).toBe(false);
    });

    it('always offers the Modules manager, even under the minimal preset', async () => {
      // The Modules manager is ungated — it must stay jumpable even when every optional feature
      // is off, since it is how they are turned back on.
      useModulesStore.getState().applyPreset('minimal');
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: '>modules' } });
      const screens = await screen.findAllByTestId('command-palette-screen');
      expect(screens[0].textContent).toContain('Manage modules');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(navigateMock).toHaveBeenCalledWith({ to: '/modules' });
    });
  });

  describe('quick actions (find → act)', () => {
    /** Search, then open the highlighted item's quick-actions panel via its chevron. */
    const openActions = async (name = '10k resistor') => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
      await screen.findAllByTestId('command-palette-result');
      fireEvent.click(screen.getByLabelText(`Quick actions for ${name}`));
      return screen.findByTestId('command-palette-action-panel');
    };

    it('opens the action panel for the highlighted item via ArrowRight, keeping Enter/open intact', async () => {
      useCommandPaletteStore.setState({ open: true });
      render(<CommandPalette />);
      const input = screen.getByTestId('command-palette-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'resistor' } });
      await screen.findAllByTestId('command-palette-result');
      // Caret at end so ArrowRight opens actions rather than moving through the query text.
      input.setSelectionRange(input.value.length, input.value.length);
      fireEvent.keyDown(input, { key: 'ArrowRight' });
      expect(await screen.findByTestId('command-palette-action-panel')).toBeTruthy();
      // Opening actions must not fire the default open/navigate.
      expect(navigateMock).not.toHaveBeenCalled();
      expect(useInventoryEntry.getState().pendingSearch).toBeNull();
    });

    it('± adjust calls useAdjustQuantity with the right delta for an active DISCRETE item', async () => {
      await openActions();
      expect(screen.getByTestId('command-palette-adjust')).toBeTruthy();
      fireEvent.click(screen.getByLabelText('Increase quantity'));
      expect(adjustMutate).toHaveBeenCalledWith({ id: 'i1', delta: 1 });
      fireEvent.click(screen.getByLabelText('Decrease quantity'));
      expect(adjustMutate).toHaveBeenCalledWith({ id: 'i1', delta: -1 });
    });

    it.each([
      ['a gauge item', { trackingMode: 'CONSUMABLE_GAUGE' as const }],
      ['a serialised item', { trackingMode: 'SERIALISED' as const, serialNo: 1 }],
      ['an untracked item', { trackingMode: 'UNTRACKED' as const }],
      ['an unlimited source', { isUnlimited: true }],
    ])('hides ± for %s', async (_label, overrides) => {
      actingItem = { ...baseItem, ...overrides };
      await openActions();
      expect(screen.queryByTestId('command-palette-adjust')).toBeNull();
    });

    it('Move calls useMoveItem with { id, locationId } for the chosen location', async () => {
      await openActions();
      fireEvent.click(screen.getByRole('combobox', { name: 'Move to location' }));
      fireEvent.click(screen.getByRole('option', { name: 'Shelf B' }));
      fireEvent.click(screen.getByTestId('command-palette-move'));
      await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledWith({ id: 'i1', locationId: 'loc-2' }));
    });

    it('Check out calls useCheckoutItem with { itemId, contactName }', async () => {
      await openActions();
      fireEvent.change(screen.getByTestId('command-palette-checkout-contact'), {
        target: { value: 'Ada' },
      });
      fireEvent.click(screen.getByTestId('command-palette-checkout'));
      await waitFor(() =>
        expect(checkoutMutateAsync).toHaveBeenCalledWith({ itemId: 'i1', contactName: 'Ada' }),
      );
    });

    it('reports a failed Move and keeps the chosen location so it can be retried', async () => {
      // Raw SQLite text, so the panel's own copy is what the user sees (the error seam only
      // prefers a thrown message when it was authored for a human).
      moveMutateAsync.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT: constraint failed'));
      await openActions();
      fireEvent.click(screen.getByRole('combobox', { name: 'Move to location' }));
      fireEvent.click(screen.getByRole('option', { name: 'Shelf B' }));
      fireEvent.click(screen.getByTestId('command-palette-move'));

      const alert = await screen.findByTestId('command-palette-action-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain('Could not move 10k resistor.');
      // No success announcement, and the picker still holds the target — one click retries.
      expect(screen.getByTestId('command-palette-action-notice').textContent).toBe('');
      expect(screen.getByRole('combobox', { name: 'Move to location' }).textContent).toContain('Shelf B');

      fireEvent.click(screen.getByTestId('command-palette-move'));
      await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledTimes(2));
      // The retry succeeded: the error clears and the success notice takes its place.
      await waitFor(() => expect(screen.queryByTestId('command-palette-action-error')).toBeNull());
      expect(screen.getByTestId('command-palette-action-notice').textContent).toContain(
        'Moved 10k resistor to Shelf B.',
      );
    });

    it('reports a failed Check out and keeps the contact name so it can be retried', async () => {
      // An authored sentence wins over the panel's fallback — the user gets the specific reason.
      checkoutMutateAsync.mockRejectedValueOnce(new Error('Not enough stock on hand.'));
      await openActions();
      fireEvent.change(screen.getByTestId('command-palette-checkout-contact'), {
        target: { value: 'Ada' },
      });
      fireEvent.click(screen.getByTestId('command-palette-checkout'));

      const alert = await screen.findByTestId('command-palette-action-error');
      expect(alert.textContent).toContain('Not enough stock on hand.');
      expect((screen.getByTestId('command-palette-checkout-contact') as HTMLInputElement).value).toBe('Ada');
    });

    it('hides Check out when the Contacts module is off, keeping Move + Open details', async () => {
      useModulesStore.getState().setFeatureIntent('contacts', false);
      await openActions();
      expect(screen.queryByTestId('command-palette-checkout')).toBeNull();
      expect(screen.getByTestId('command-palette-move')).toBeTruthy();
      expect(screen.getByTestId('command-palette-open-details')).toBeTruthy();
    });

    it('Open details hands the name to inventory and navigates (jump-to-item)', async () => {
      await openActions();
      fireEvent.click(screen.getByTestId('command-palette-open-details'));
      expect(useInventoryEntry.getState().pendingSearch).toBe('10k resistor');
      expect(navigateMock).toHaveBeenCalledWith({ to: '/inventory' });
    });

    it('Back returns to the results without closing the palette', async () => {
      await openActions();
      fireEvent.click(screen.getByTestId('command-palette-actions-back'));
      await screen.findAllByTestId('command-palette-result');
      expect(screen.queryByTestId('command-palette-action-panel')).toBeNull();
      // The palette itself stays open.
      expect(screen.getByTestId('command-palette-input')).toBeTruthy();
    });
  });
});
