import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { CreateItemDialog } from './CreateItemDialog';

const spies = vi.hoisted(() => ({
  createItem: vi.fn(),
  createSerialised: vi.fn(),
  applyScrape: vi.fn(),
  createLocation: vi.fn(),
  createCategory: vi.fn(),
}));

vi.mock('../mutations', () => ({
  useCreateItem: () => ({ mutate: spies.createItem, isPending: false }),
  useCreateSerialisedItems: () => ({ mutate: spies.createSerialised, isPending: false }),
  useApplyScrape: () => ({ mutate: spies.applyScrape, isPending: false }),
  useCreateLocation: () => ({ mutate: spies.createLocation, isPending: false }),
}));

vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: [{ id: 'cat-1', name: 'Resistors' }] } }),
  useCreateCategory: () => ({ mutate: spies.createCategory, isPending: false }),
}));

// The scrape panel needs the companion extension plumbing — inert here.
vi.mock('@/features/scraping', () => ({
  ScrapeSupplierPanel: () => null,
  useScrapeNotifier: () => vi.fn(),
  buildScrapeMergePlan: vi.fn(),
  applyScrapeMerge: vi.fn(),
}));

afterEach(() => {
  cleanup();
  spies.createItem.mockReset();
  spies.createSerialised.mockReset();
  spies.createLocation.mockReset();
  spies.createCategory.mockReset();
});

const locations: LocationWithCount[] = [];

function renderDialog() {
  render(<CreateItemDialog open onClose={() => {}} locations={locations} />);
}

const itemDialog = () => within(screen.getByRole('dialog', { name: 'Add item' }));

describe('CreateItemDialog', () => {
  it('lands initial focus in the Name field, ready to type', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('submits description, notes and the per-item low-stock override', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M3 screws' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Socket head, stainless' },
    });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Bought at the swap meet' },
    });
    fireEvent.change(screen.getByLabelText('Low-stock alert at (optional)'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Reorder quantity (optional)'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    // react-hook-form validates asynchronously before the submit handler runs.
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'M3 screws',
      description: 'Socket head, stainless',
      notes: 'Bought at the swap meet',
      reorderPoint: 3,
      reorderQty: 100,
    });
  });

  it('omits blank optional fields from the create input', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Plain item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    const input = spies.createItem.mock.calls[0][0];
    expect(input.description).toBeUndefined();
    expect(input.notes).toBeUndefined();
    expect(input.reorderPoint).toBeUndefined();
  });

  it('offers Untracked and hides quantity + low-stock fields for it', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Tracking'), { target: { value: 'UNTRACKED' } });

    expect(screen.queryByLabelText('Initial quantity')).toBeNull();
    expect(screen.queryByLabelText('Low-stock alert at (optional)')).toBeNull();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bench vice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    const input = spies.createItem.mock.calls[0][0];
    expect(input.trackingMode).toBe('UNTRACKED');
    expect(input.quantity).toBeUndefined();
    expect(input.gauge).toBeUndefined();
  });

  it('creates a category inline without losing the form, then submits with it', async () => {
    spies.createCategory.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ id: 'cat-9', name: 'Tools', createdAt: 0, updatedAt: 0 }),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Torque wrench' } });

    // Choosing "＋ New category…" stacks the quick-create dialog on top.
    fireEvent.change(screen.getByLabelText('Category (optional)'), {
      target: { value: '__create-category__' },
    });
    const catDialog = within(await screen.findByRole('dialog', { name: 'Add category' }));
    fireEvent.change(catDialog.getByLabelText('Name'), { target: { value: 'Tools' } });
    fireEvent.click(catDialog.getByRole('button', { name: 'Create' }));

    expect(spies.createCategory).toHaveBeenCalledWith({ name: 'Tools' }, expect.anything());
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add category' })).toBeNull(),
    );

    // The item form survived (name intact) and now carries the new category.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Torque wrench');
    fireEvent.click(itemDialog().getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'Torque wrench',
      categoryId: 'cat-9',
    });
  });

  it('creates a location inline without losing the form, then submits with it', async () => {
    spies.createLocation.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ id: 'loc-9', name: 'Drawer 9' }),
    );
    renderDialog();
    fireEvent.change(itemDialog().getByLabelText('Name'), { target: { value: 'Calipers' } });

    // Open the location picker and choose the pinned "＋ New location…" row.
    fireEvent.click(itemDialog().getByRole('combobox', { name: 'Location' }));
    fireEvent.click(itemDialog().getByRole('option', { name: /New location…/ }));

    const locDialog = within(await screen.findByRole('dialog', { name: 'Add location' }));
    fireEvent.change(locDialog.getByLabelText('Name'), { target: { value: 'Drawer 9' } });
    fireEvent.click(locDialog.getByRole('button', { name: 'Create' }));

    expect(spies.createLocation).toHaveBeenCalledTimes(1);
    expect(spies.createLocation.mock.calls[0][0]).toMatchObject({ name: 'Drawer 9' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull(),
    );

    // The item form survived and now targets the freshly-created location.
    expect((itemDialog().getByLabelText('Name') as HTMLInputElement).value).toBe('Calipers');
    fireEvent.click(itemDialog().getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'Calipers',
      locationId: 'loc-9',
    });
  });
});
