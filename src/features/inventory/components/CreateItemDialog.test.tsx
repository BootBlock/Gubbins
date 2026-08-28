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

// A mutable flag so a test can put the create mutation into its in-flight state and assert the
// "Creating item…" progress feedback (issue #57). Reset between tests.
const mockState = vi.hoisted(() => ({ createItemPending: false }));

vi.mock('../mutations', () => ({
  useCreateItem: () => ({ mutate: spies.createItem, isPending: mockState.createItemPending }),
  useCreateSerialisedItems: () => ({ mutate: spies.createSerialised, isPending: false }),
  useApplyScrape: () => ({ mutate: spies.applyScrape, isPending: false }),
  useCreateLocationPath: () => ({ mutate: spies.createLocation, isPending: false }),
  // Path A2 active-tab supplier-part persistence (only fired when `initialScrape` is passed).
  useCreateSupplierPart: () => ({ mutate: spies.createSupplierPart, isPending: false }),
}));

// The shared-image attach path (plan EI-4) uses useAddItemImage — stub it so no QueryClient/DB
// is needed and we can assert the shared image is attached to the freshly-created item.
vi.mock('../media', () => ({
  useAddItemImage: () => ({ mutate: spies.addImage, isPending: false }),
}));

vi.mock('../categories', () => ({
  useCategories: () => ({
    data: {
      rows: [
        { id: 'cat-1', name: 'Resistors' },
        // A category template carrying default facets (backlog T1 tracking mode + T2 condition /
        // warranty window) that soft-prefill the create form when the category is chosen.
        {
          id: 'cat-tools',
          name: 'Tools',
          defaultTrackingMode: 'SERIALISED',
          defaultCondition: 'GOOD',
          defaultWarrantyMonths: 12,
        },
        // A category that declares its items have no expiry, batch identity or warranty
        // (issue #618) — and sets a warranty window anyway, which must not be pre-filled into
        // a box the user cannot see.
        {
          id: 'cat-movies',
          name: 'Movies',
          defaultWarrantyMonths: 24,
          hiddenCapabilities: ['perishables', 'batches'],
        },
      ],
    },
  }),
  useCreateCategory: () => ({ mutate: spies.createCategory, isPending: false }),
}));

// Keep the real queries module (other dialog children read from it) but stub the field
// suggestions so no QueryClient/DB is needed for the autocomplete fields.
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  useFieldSuggestions: () => ({ data: [] }),
  // The Barcode field's duplicate advisory (issue #513). This dialog renders without a
  // QueryClient, and nothing carries the code here, so the read is stubbed rather than run.
  useBarcodeCarriers: () => ({ data: [] }),
}));

// The camera barcode-capture dialog (issue #8) owns the real getUserMedia/decoder plumbing,
// covered by its own test. Here it is stubbed to a button that hands back a decoded barcode,
// so this test can pin the *wiring*: the Scan trigger opens it, and a captured code fills the
// Barcode field. When closed it renders nothing (matching the real component's `open` guard).
vi.mock('@/features/scanner/components/BarcodeScanDialog', () => ({
  BarcodeScanDialog: ({ open, onCapture }: { open: boolean; onCapture: (barcode: string) => void }) =>
    open ? (
      <button type="button" data-testid="mock-barcode-capture" onClick={() => onCapture('4006381333931')}>
        capture
      </button>
    ) : null,
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
  mockState.createItemPending = false;
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

  it('shows an announced "Creating item…" status while the create is in flight (issue #57)', () => {
    // Not pending → no status label; the Create button is enabled.
    renderDialog();
    expect(itemDialog().queryByTestId('create-item-status')).toBeNull();
    expect(itemDialog().getByRole('button', { name: 'Create item' })).toBeEnabled();
    cleanup();

    // In-flight → a politely-announced status label, and the Create button is disabled.
    mockState.createItemPending = true;
    renderDialog();
    const status = itemDialog().getByTestId('create-item-status');
    expect(status).toHaveTextContent('Creating item…');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(itemDialog().getByRole('button', { name: 'Create item' })).toBeDisabled();
  });

  it('guards against a double-submit creating a duplicate item (issue #294)', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M3 screws' } });

    // Two rapid submits before the create-chain settles — the create mutation's stub never
    // fires its onSuccess, so `done()` never runs and the dialog stays open with the form
    // intact, reproducing the window the bug exploited. RHF validation is async, so both
    // clicks clear validation before either lands; only the first must reach the mutation.
    const createButton = itemDialog().getByRole('button', { name: 'Create item' });
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));

    // The button stays disabled (and the status stays announced) for the whole post-create
    // chain, not just the create mutation — so no further click can duplicate the item.
    expect(itemDialog().getByRole('button', { name: 'Create item' })).toBeDisabled();
    expect(itemDialog().getByTestId('create-item-status')).toHaveTextContent('Creating item…');
  });

  it('submits description, notes and a custom per-item low-stock override', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M3 screws' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Socket head, stainless' },
    });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Bought at the swap meet' },
    });
    // The trigger fields are hidden until the "Custom" policy is chosen.
    expect(screen.queryByTestId('item-reorder-point')).toBeNull();
    fireEvent.click(screen.getByTestId('low-stock-policy-custom'));
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

  it('defaults to the global policy — no reorder point submitted', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unwatched' } });
    // Leave the policy on its default (follow the global blanket).
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    const input = spies.createItem.mock.calls[0][0];
    expect(input.reorderPoint).toBeUndefined();
    expect(input.reorderQty).toBeUndefined();
  });

  it('submits a hard exemption (reorderPoint 0) for the "Never" policy', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Silent' } });
    fireEvent.click(screen.getByTestId('low-stock-policy-never'));
    // "Never" has no trigger field to fill.
    expect(screen.queryByTestId('item-reorder-point')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0].reorderPoint).toBe(0);
  });

  it('seeds a suggested reorder point the moment "Custom" is chosen', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Watched' } });
    fireEvent.click(screen.getByTestId('low-stock-policy-custom'));
    // The revealed field is pre-filled with the suggested trigger (5), not left blank.
    expect(screen.getByLabelText('Low-stock alert at')).toHaveValue('5');
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

    // The dialog's own copy is shown, not the raw SQLite text (issue #311): this failure carries
    // no code to humanise from, and untranslated internal jargon helps nobody using the app.
    expect(await screen.findByText('The item was not saved. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('no such column: is_unlimited')).toBeNull();
    expect(screen.getByText('Couldn’t create item')).toBeInTheDocument();
  });

  it('offers Untracked and hides quantity + low-stock fields for it', async () => {
    renderDialog();
    // Tracking is a custom listbox combobox now — open it and click the option.
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Untracked' }));

    expect(screen.queryByLabelText('Initial quantity')).toBeNull();
    // The low-stock policy picker only exists for stock-bearing modes.
    expect(screen.queryByTestId('low-stock-policy-custom')).toBeNull();

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

  it('soft-prefills the tracking mode from the selected category default (backlog T1)', async () => {
    renderDialog();
    // Selecting the "Tools" category (default SERIALISED) fills the still-untouched Tracking field.
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Tools' }));

    // The Tracking combobox now reflects the category's default, and the serialised-only
    // "how many" field it drives has appeared.
    expect(screen.getByRole('combobox', { name: 'Tracking' })).toHaveTextContent('Serialised');
    expect(screen.getByLabelText(/How many/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Torque wrench' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    // A serialised create routes through the clone mutation with the prefilled mode.
    await waitFor(() => expect(spies.createSerialised).toHaveBeenCalledTimes(1));
    expect(spies.createSerialised.mock.calls[0][0]).toMatchObject({
      name: 'Torque wrench',
      categoryId: 'cat-tools',
      trackingMode: 'SERIALISED',
    });
  });

  it('never re-stomps a manually chosen tracking mode when a category is selected (backlog T1)', async () => {
    renderDialog();
    // The user picks a tracking mode by hand FIRST…
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Untracked' }));
    expect(screen.getByRole('combobox', { name: 'Tracking' })).toHaveTextContent('Untracked');

    // …then selects the Tools category (default SERIALISED). The manual choice must win —
    // the soft prefill's dirty-check keeps it from re-stomping.
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Tools' }));

    expect(screen.getByRole('combobox', { name: 'Tracking' })).toHaveTextContent('Untracked');
    // Still Untracked, so the serialised-only "how many" field never appears.
    expect(screen.queryByLabelText(/How many/)).toBeNull();
  });

  // Issue #677: "How many" is the one field that turns a single submit into N irreversible
  // records, so it is bounded — and a big batch stops for confirmation first.
  it('reports an out-of-range serialised count on the field instead of creating it', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drill' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serialised' }));

    // A slipped keystroke — 10 typed as 10000.
    fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    expect(await screen.findByText('Enter a whole number between 1 and 500.')).toBeInTheDocument();
    expect(spies.createSerialised).not.toHaveBeenCalled();
  });

  // An overflowed value is `Infinity` once parsed — the case that used to spin the create loop
  // until the tab was killed. Checked from a clean form (not after another rejected submit) so
  // the error must be re-derived, and asserting the confirmation never opens: without the
  // schema guard `Infinity` clears the confirmation threshold and would stage a bulk create.
  it('rejects an overflowed serialised count rather than staging a create', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drill' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serialised' }));

    fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '1e400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    expect(await screen.findByText('Enter a whole number between 1 and 500.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /separate records/ })).toBeNull();
    expect(spies.createSerialised).not.toHaveBeenCalled();
  });

  it('confirms a bulk serialised create before making the records', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drill' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serialised' }));
    fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    // Nothing is created yet — the confirmation stacks on top of the still-filled form.
    const confirm = within(await screen.findByRole('dialog', { name: 'Create 50 separate records?' }));
    expect(spies.createSerialised).not.toHaveBeenCalled();

    // Backing out returns to the form with everything intact, so the count can be corrected.
    fireEvent.click(confirm.getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /separate records/ })).toBeNull());
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Drill');
    expect(spies.createSerialised).not.toHaveBeenCalled();

    // Confirming creates exactly what was submitted.
    fireEvent.click(itemDialog().getByRole('button', { name: 'Create item' }));
    fireEvent.click(await screen.findByTestId('confirm-bulk-serialised'));
    await waitFor(() => expect(spies.createSerialised).toHaveBeenCalledTimes(1));
    expect(spies.createSerialised.mock.calls[0][0]).toMatchObject({
      name: 'Drill',
      trackingMode: 'SERIALISED',
      count: 50,
    });
  });

  it('creates an everyday serialised batch without a confirmation step', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drill' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serialised' }));
    fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createSerialised).toHaveBeenCalledTimes(1));
    expect(spies.createSerialised.mock.calls[0][0]).toMatchObject({ name: 'Drill', count: 3 });
    expect(screen.queryByRole('dialog', { name: /separate records/ })).toBeNull();
  });

  it('soft-prefills condition and warranty window from the selected category default (backlog T2)', async () => {
    renderDialog();
    // Set the name and choose the "Tools" category on the Details tab (it carries T2 defaults)
    // before leaving for the Lifecycle tab, where the facets the defaults fill live.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Torque wrench' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Tools' }));

    // The lifecycle facets those defaults fill live on the Lifecycle rail tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    expect(screen.getByRole('combobox', { name: 'Condition (optional)' })).toHaveTextContent('Good');
    expect(screen.getByTestId('item-warranty-months')).toHaveValue('12');

    // On create, the condition rides along and the months window becomes an absolute expiry
    // date (no acquired date set ⇒ measured from today, so ~12 months out — next year). The
    // footer Create submits from any tab.
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    // Tools defaults SERIALISED, so the create routes through the clone mutation.
    await waitFor(() => expect(spies.createSerialised).toHaveBeenCalledTimes(1));
    const payload = spies.createSerialised.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'Torque wrench', condition: 'GOOD' });
    expect(payload.warrantyExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.warrantyExpiresAt.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 1));
  });

  it('never re-stomps a manually set condition or warranty when a category is selected (backlog T2)', async () => {
    renderDialog();
    // The user sets the lifecycle facets by hand FIRST, on the Lifecycle tab…
    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Condition (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Needs repair' }));
    fireEvent.change(screen.getByTestId('item-warranty-months'), { target: { value: '36' } });

    // …then selects the Tools category (defaults GOOD + 12) back on the Details tab. The manual
    // choices must win — each facet's dirty-check keeps the soft prefill from re-stomping it.
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Tools' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    expect(screen.getByRole('combobox', { name: 'Condition (optional)' })).toHaveTextContent('Needs repair');
    expect(screen.getByTestId('item-warranty-months')).toHaveValue('36');
  });

  it('derives the warranty expiry from the acquired date + months window at submit (backlog T2)', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Calibrated gauge' } });
    // Enter an explicit acquired date + a 24-month warranty on the Lifecycle tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    fireEvent.change(screen.getByTestId('item-acquired'), { target: { value: '2026-01-15' } });
    fireEvent.change(screen.getByTestId('item-warranty-months'), { target: { value: '24' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    // DISCRETE default ⇒ the plain create mutation; the window is measured from the acquired date.
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'Calibrated gauge',
      acquiredAt: '2026-01-15',
      warrantyExpiresAt: '2028-01-15',
    });
  });

  it('fills the barcode field from a camera scan and submits it (issue #8)', async () => {
    renderDialog();
    // The Scan button sits beside the Barcode field; opening it hands back a decoded barcode.
    fireEvent.click(screen.getByTestId('item-barcode-scan'));
    fireEvent.click(screen.getByTestId('mock-barcode-capture'));

    // The captured code fills the field (an explicit action, so it overwrites).
    expect(screen.getByLabelText('Barcode (optional)')).toHaveValue('4006381333931');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Scanned item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({
      name: 'Scanned item',
      barcode: '4006381333931',
    });
  });

  it('rejects an invalid ASIN with an accessible error', () => {
    renderDialog();
    // The ASIN capture lives on the "Supplier & ops" rail tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Supplier & ops' }));
    fireEvent.change(screen.getByLabelText('Record as an Amazon supplier part (optional)'), {
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
    // ASIN capture lives on the "Supplier & ops" rail tab; fill it there.
    fireEvent.click(screen.getByRole('tab', { name: 'Supplier & ops' }));
    fireEvent.change(screen.getByLabelText('Record as an Amazon supplier part (optional)'), {
      target: { value: 'https://www.amazon.co.uk/dp/B0TEST0001?ref=example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record Amazon part' }));

    // A valid ASIN confirms inline. The ASIN and listing URL are captured structurally on the
    // supplier part (order code + link), so Notes (on the Details tab) is left untouched — no
    // redundant provenance.
    expect(screen.getByTestId('item-asin-applied')).toHaveTextContent('B0TEST0001');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('');

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
    // createPath resolves with the created/resolved leaves (an array); the inline picker
    // selects the first.
    spies.createLocation.mockImplementation((_input, opts) =>
      opts?.onSuccess?.([{ id: 'loc-9', name: 'Drawer 9' }]),
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

  it('keeps fields typed on one rail tab when another tab is visited (single form spans tabs)', async () => {
    renderDialog();
    // Type identity fields on Details, then a batch/lot on the Lifecycle tab, then come back.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Epoxy resin' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    fireEvent.change(screen.getByLabelText('Batch no. (optional)'), { target: { value: 'B-42' } });
    // Returning to Details, the earlier name is still present (RHF retains an unmounted tab).
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Epoxy resin');

    // A single Create submits fields from across every tab at once.
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    expect(spies.createItem.mock.calls[0][0]).toMatchObject({ name: 'Epoxy resin', batchNumber: 'B-42' });
  });

  it('jumps the rail to the tab holding the first error when a submit is rejected', async () => {
    renderDialog();
    // Leave Name empty and submit from a different tab — the error would otherwise sit on the
    // unmounted Details panel with the user staring at a Create that "did nothing".
    fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    // The rail jumps back to Details and surfaces the required-name error there.
    expect(await screen.findByText('Please enter a name.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(spies.createItem).not.toHaveBeenCalled();
  });
});

/**
 * Issue #618 — the create form offers only the lifecycle fields the chosen category's items
 * actually have. Two things matter here: the boxes disappear, and — the part that would make
 * hiding *write* rather than merely hide — a category default is never stamped into a box the
 * user cannot see. React Hook Form keeps the value of an unmounted field, so this needs
 * guarding at the write, not just at the render.
 */
describe('CreateItemDialog — lifecycle fields a category hides', () => {
  const chooseCategory = (name: string) => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Category (optional)' }));
    fireEvent.click(screen.getByRole('option', { name }));
  };
  /** The lifecycle facets live on their own rail tab, and only the active panel is mounted. */
  const openLifecycleTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }));

  it('shows expiry and batch boxes for a category that hides nothing', () => {
    renderDialog();
    chooseCategory('Resistors');
    openLifecycleTab();
    expect(screen.getByTestId('item-expiry')).toBeInTheDocument();
    expect(screen.getByLabelText(/Batch no\./)).toBeInTheDocument();
  });

  it('drops them for a category whose items have no expiry or batch identity', () => {
    renderDialog();
    chooseCategory('Movies');
    openLifecycleTab();
    expect(screen.queryByTestId('item-expiry')).toBeNull();
    expect(screen.queryByLabelText(/Batch no\./)).toBeNull();
    expect(screen.queryByLabelText(/Lot no\./)).toBeNull();
  });

  it('still pre-fills the warranty window when the box is visible', () => {
    renderDialog();
    chooseCategory('Tools');
    openLifecycleTab();
    expect(screen.getByTestId('item-warranty-months')).toHaveValue('12');
  });

  it('never submits a value from a box the category hid after it was typed', async () => {
    // Type an expiry and a batch first, *then* pick a category that hides both. React Hook Form
    // keeps an unmounted field's value, so without the write-side guard these would be stored
    // on an item that never showed them — hiding would write rather than merely hide.
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Blade Runner' } });
    openLifecycleTab();
    fireEvent.change(screen.getByTestId('item-expiry'), { target: { value: '2027-03-01' } });
    fireEvent.change(screen.getByLabelText(/Batch no\./), { target: { value: 'B-1' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    chooseCategory('Movies');
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(spies.createItem).toHaveBeenCalledTimes(1));
    const submitted = spies.createItem.mock.calls[0][0];
    expect(submitted).toMatchObject({ name: 'Blade Runner' });
    expect(submitted).not.toHaveProperty('expiryDate');
    expect(submitted).not.toHaveProperty('batchNumber');
    // Warranty is deliberately *not* category-hideable — its section also holds the purchase
    // record — so the category's 24-month window still pre-fills a visible box and is derived
    // as normal. Its guard is the device's module, tested separately.
    expect(submitted.warrantyExpiresAt).not.toBeNull();
  });
});
