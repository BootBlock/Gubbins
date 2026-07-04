import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { ToastProvider } from '@/components/foundry';
import { CreateItemDialog } from './CreateItemDialog';

const spies = vi.hoisted(() => ({
  createItem: vi.fn(),
  createSerialised: vi.fn(),
  applyScrape: vi.fn(),
  createLocation: vi.fn(),
  createCategory: vi.fn(),
  addImage: vi.fn(),
  createSupplierPart: vi.fn(),
}));

vi.mock('../mutations', () => ({
  useCreateItem: () => ({ mutate: spies.createItem, isPending: false }),
  useCreateSerialisedItems: () => ({ mutate: spies.createSerialised, isPending: false }),
  useApplyScrape: () => ({ mutate: spies.applyScrape, isPending: false }),
  useCreateLocation: () => ({ mutate: spies.createLocation, isPending: false }),
  // Path A2 active-tab supplier-part persistence (only fired when `initialScrape` is passed).
  useCreateSupplierPart: () => ({ mutate: spies.createSupplierPart, isPending: false }),
}));

// The shared-image attach path (plan EI-4) uses useAddItemImage — stub it so no QueryClient/DB
// is needed and we can assert the shared image is attached to the freshly-created item.
vi.mock('../media', () => ({
  useAddItemImage: () => ({ mutate: spies.addImage, isPending: false }),
}));

vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: [{ id: 'cat-1', name: 'Resistors' }] } }),
  useCreateCategory: () => ({ mutate: spies.createCategory, isPending: false }),
}));

// Keep the real queries module (other dialog children read from it) but stub the field
// suggestions so no QueryClient/DB is needed for the autocomplete fields.
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  useFieldSuggestions: () => ({ data: [] }),
}));

// The scrape panel needs the companion extension plumbing — inert here.
vi.mock('@/features/scraping', () => ({
  ScrapeSupplierPanel: () => null,
  ProductLookupPanel: () => null,
  useScrapeNotifier: () => vi.fn(),
  buildScrapeMergePlan: vi.fn(),
  applyScrapeMerge: vi.fn(),
  buildSupplierPartPlan: vi.fn(),
  resolveSupplierPartWrite: vi.fn(),
}));

afterEach(() => {
  cleanup();
  spies.createItem.mockReset();
  spies.createSerialised.mockReset();
  spies.createLocation.mockReset();
  spies.createCategory.mockReset();
  spies.addImage.mockReset();
  spies.createSupplierPart.mockReset();
});

const locations: LocationWithCount[] = [];

// The dialog surfaces create failures through the Foundry toast, so every render is wrapped
// in a ToastProvider (as it is under <App>) — without it useToast() throws on mount.
function renderDialog() {
  render(<CreateItemDialog open onClose={() => {}} locations={locations} />, { wrapper: ToastProvider });
}

const itemDialog = () => within(screen.getByRole('dialog', { name: 'Add item' }));

describe('CreateItemDialog', () => {
  it('lands initial focus in the Name field, ready to type', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('submits description, notes and the per-item low-stock override once opted in', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M3 screws' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Socket head, stainless' },
    });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Bought at the swap meet' },
    });
    // Low-stock is opt-in: the threshold fields are hidden until the toggle is switched on.
    expect(screen.queryByTestId('item-reorder-point')).toBeNull();
    fireEvent.click(screen.getByTestId('item-low-stock-alert'));
    fireEvent.change(screen.getByLabelText('Low-stock alert at'), { target: { value: '3' } });
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

  it('leaves low-stock alerts off by default — no reorder point unless opted in', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unwatched' } });
    // Deliberately do NOT touch the "Alert me when this runs low" toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    const input = spies.createItem.mock.calls[0][0];
    expect(input.reorderPoint).toBeUndefined();
    expect(input.reorderQty).toBeUndefined();
  });

  it('seeds a suggested reorder point the moment low-stock alerts are switched on', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Watched' } });
    fireEvent.click(screen.getByTestId('item-low-stock-alert'));
    // The revealed field is pre-filled with the suggested trigger (5), not left blank.
    expect(screen.getByLabelText('Low-stock alert at')).toHaveValue(5);
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0].reorderPoint).toBe(5);
  });

  it('pre-fills a shared draft from initialValues and submits them (plan EI-4)', async () => {
    render(
      <CreateItemDialog
        open
        onClose={() => {}}
        locations={locations}
        initialValues={{
          name: 'USB-C Cable',
          mpn: 'B0F3XF5ZKF',
          barcode: '4006381333931',
          notes: 'Added via Share to Gubbins.\nSource: https://example.test/c',
        }}
      />,
      { wrapper: ToastProvider },
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('USB-C Cable');
    expect((screen.getByLabelText('MPN (optional)') as HTMLInputElement).value).toBe('B0F3XF5ZKF');
    // A scanned barcode (recommendation point 1) pre-fills its field.
    expect((screen.getByLabelText('Barcode (optional)') as HTMLInputElement).value).toBe('4006381333931');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toContain(
      'Added via Share to Gubbins.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'USB-C Cable',
      mpn: 'B0F3XF5ZKF',
      barcode: '4006381333931',
    });
  });

  it('attaches a shared image to the item once it is created (plan EI-4)', async () => {
    spies.createItem.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ id: 'item-77', name: 'Shared thing' }),
    );
    const image = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    render(
      <CreateItemDialog
        open
        onClose={() => {}}
        locations={locations}
        initialValues={{ name: 'Shared thing' }}
        initialImage={image}
      />,
      { wrapper: ToastProvider },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.addImage).toHaveBeenCalledTimes(1));
    expect(spies.addImage.mock.calls[0][0]).toMatchObject({ itemId: 'item-77', file: image });
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

  it('surfaces a create failure in a toast instead of silently doing nothing', async () => {
    // A failing create (e.g. a `no such column` from a schema-stale local DB) must tell the
    // user — the dialog previously swallowed the error and just sat there.
    spies.createItem.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('no such column: is_unlimited')),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Doomed item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    // The raw error message is shown so the cause is diagnosable.
    expect(await screen.findByText('no such column: is_unlimited')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t create item')).toBeInTheDocument();
  });

  it('offers Untracked and hides quantity + low-stock fields for it', async () => {
    renderDialog();
    // Tracking is a custom listbox combobox now — open it and click the option.
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Untracked' }));

    expect(screen.queryByLabelText('Initial quantity')).toBeNull();
    // The low-stock opt-in (and its threshold field) only exist for stock-bearing modes.
    expect(screen.queryByTestId('item-low-stock-alert')).toBeNull();

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

    // Choosing "＋ New category…" stacks the quick-create dialog on top. The Category
    // picker is now a custom listbox combobox, so open it and click the action row.
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: '＋ New category…' }));
    const catDialog = within(await screen.findByRole('dialog', { name: 'Add category' }));
    fireEvent.change(catDialog.getByLabelText('Name'), { target: { value: 'Tools' } });
    fireEvent.click(catDialog.getByRole('button', { name: 'Create' }));

    expect(spies.createCategory).toHaveBeenCalledWith({ name: 'Tools' }, expect.anything());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add category' })).toBeNull());

    // The item form survived (name intact) and now carries the new category.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Torque wrench');
    fireEvent.click(itemDialog().getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'Torque wrench',
      categoryId: 'cat-9',
    });
  });

  it('rejects an invalid ASIN with an accessible error', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Add by Amazon ASIN or link (optional)'), {
      target: { value: 'not-an-asin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record Amazon part' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid Amazon ASIN/i);
    // No confirmation is shown for a rejected value.
    expect(screen.queryByTestId('item-asin-applied')).toBeNull();
  });

  it('records an Amazon supplier part from a typed ASIN link on create (offline single-item add)', async () => {
    const scraping = await import('@/features/scraping');
    // The synthesised payload is fed through the real §4 write path in production; here the
    // scraping module is mocked, so drive the two seams to return a create for a fresh item.
    vi.mocked(scraping.buildSupplierPartPlan).mockReturnValue({
      supplierName: 'Amazon',
      matchedId: null,
      proposals: [],
    });
    vi.mocked(scraping.resolveSupplierPartWrite).mockReturnValue({
      kind: 'create',
      input: {
        supplierName: 'Amazon',
        orderCode: 'B0TEST0001',
        url: 'https://www.amazon.co.uk/dp/B0TEST0001',
        source: 'SCRAPE',
      },
    });
    spies.createItem.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ id: 'item-42', name: 'USB-C Cable' }),
    );

    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'USB-C Cable' } });
    fireEvent.change(screen.getByLabelText('Add by Amazon ASIN or link (optional)'), {
      target: { value: 'https://www.amazon.co.uk/dp/B0TEST0001?ref=example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record Amazon part' }));

    // A valid ASIN confirms inline and seeds the notes provenance.
    expect(screen.getByTestId('item-asin-applied')).toHaveTextContent('B0TEST0001');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toContain(
      'Amazon ASIN: B0TEST0001',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createSupplierPart).toHaveBeenCalledTimes(1));

    // The synthesised payload carries the ASIN as the order code + its canonical listing URL.
    expect(vi.mocked(scraping.buildSupplierPartPlan).mock.calls[0][0]).toMatchObject({
      mpn: 'B0TEST0001',
      distributor_url: 'https://www.amazon.co.uk/dp/B0TEST0001',
    });
    // The supplier part is attached to the freshly-created item (§4 no-overwrite-safe create).
    expect(spies.createSupplierPart.mock.calls[0][0]).toMatchObject({
      itemId: 'item-42',
      input: { supplierName: 'Amazon', orderCode: 'B0TEST0001' },
    });
    // The ASIN is Amazon's order code, not the item's own MPN — the MPN field stays empty.
    expect((screen.getByLabelText('MPN (optional)') as HTMLInputElement).value).toBe('');
  });

  it('creates a location inline without losing the form, then submits with it', async () => {
    spies.createLocation.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ id: 'loc-9', name: 'Drawer 9' }),
    );
    renderDialog();
    fireEvent.change(itemDialog().getByLabelText('Name'), { target: { value: 'Calipers' } });

    // Open the location picker and choose the pinned "＋ New location…" row. The listbox is
    // portalled to document.body (to escape the dialog's scroll clip), so query it via screen.
    fireEvent.click(itemDialog().getByRole('combobox', { name: 'Location' }));
    fireEvent.click(screen.getByRole('option', { name: /New location…/ }));

    const locDialog = within(await screen.findByRole('dialog', { name: 'Add location' }));
    fireEvent.change(locDialog.getByLabelText('Name'), { target: { value: 'Drawer 9' } });
    fireEvent.click(locDialog.getByRole('button', { name: 'Create' }));

    expect(spies.createLocation).toHaveBeenCalledTimes(1);
    expect(spies.createLocation.mock.calls[0][0]).toMatchObject({ name: 'Drawer 9' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());

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
