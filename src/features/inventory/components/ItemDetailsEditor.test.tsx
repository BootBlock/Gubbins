import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ItemDetailsEditor } from './ItemDetailsEditor';

const spies = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../mutations', () => ({
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
}));

vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: [{ id: 'cat-1', name: 'Resistors' }] } }),
}));

vi.mock('../queries', () => ({
  useFieldSuggestions: () => ({ data: [] }),
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

afterEach(() => {
  cleanup();
  spies.update.mockReset();
  // The preferences store is a persisted singleton; restore the default units so a test that
  // switches them (issue #158) doesn't leak grams→ounces into the grams/mm-asserting tests.
  usePreferencesStore.getState().setWeightUnit('g');
  usePreferencesStore.getState().setDimensionUnit('mm');
});

const item: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: 'Single bipolar timer IC',
  notes: null,
  locationId: 'loc-1',
  categoryId: 'cat-1',
  trackingMode: 'DISCRETE',
  quantity: 10,
  serialNo: null,
  mpn: 'NE555P',
  manufacturer: 'Texas Instruments',
  barcode: null,
  unitCost: 0.4,
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

describe('ItemDetailsEditor', () => {
  it('seeds the draft from the item and starts pristine (Save disabled)', () => {
    render(<ItemDetailsEditor item={item} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('NE555 timer');
    expect((screen.getByLabelText('Description (optional)') as HTMLTextAreaElement).value).toBe(
      'Single bipolar timer IC',
    );
    // The Category picker is a custom listbox combobox now — the trigger shows the
    // selected category's *name* (cat-1 → "Resistors"), not its raw id.
    expect(screen.getByRole('combobox', { name: 'Category' }).textContent).toContain('Resistors');
    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);
  });

  it('saves edited fields wholesale, blanking optional text back to null', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Pin 3 is bent' },
    });
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0]).toEqual({
      id: 'item-1',
      input: expect.objectContaining({
        name: 'NE555 timer',
        notes: 'Pin 3 is bent',
        description: null,
      }),
    });
  });

  it('saves an entered weight as canonical grams (default unit is grams)', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByTestId('item-details-weight'), { target: { value: '1600' } });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(expect.objectContaining({ weight: 1600 }));
  });

  it('saves entered dimensions as canonical millimetres (default unit is mm)', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByTestId('item-details-width'), { target: { value: '400' } });
    fireEvent.change(screen.getByTestId('item-details-height'), { target: { value: '300' } });
    fireEvent.change(screen.getByTestId('item-details-depth'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ width: 400, height: 300, depth: 250 }),
    );
  });

  it('refuses to save a negative weight instead of clearing the stored one (issue #345)', () => {
    render(<ItemDetailsEditor item={{ ...item, weight: 500 }} />);
    fireEvent.change(screen.getByTestId('item-details-weight'), { target: { value: '-5' } });

    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toMatch(/negative/i);
    fireEvent.click(screen.getByTestId('item-details-save'));
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('refuses to save a negative dimension or unit cost', () => {
    render(<ItemDetailsEditor item={{ ...item, width: 400 }} />);
    fireEvent.change(screen.getByTestId('item-details-width'), { target: { value: '-1' } });
    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByTestId('item-details-width'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Unit cost (optional)'), { target: { value: '-2' } });
    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toMatch(/negative/i);
  });

  it('still clears a stored weight when the field is blanked', () => {
    render(<ItemDetailsEditor item={{ ...item, weight: 500 }} />);
    fireEvent.change(screen.getByTestId('item-details-weight'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update.mock.calls[0][0].input).toEqual(expect.objectContaining({ weight: null }));
  });

  it('refuses to save a blank name', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toMatch(/enter a name/i);
  });

  it('offers the Bulk ↔ Untracked switch on a Discrete item and saves the new mode', () => {
    render(<ItemDetailsEditor item={item} />);
    // Tracking is a custom listbox combobox — open it and click the option.
    const tracking = screen.getByRole('combobox', { name: 'Tracking' });
    expect(tracking).toHaveTextContent('Bulk');

    fireEvent.click(tracking);
    fireEvent.click(screen.getByRole('option', { name: 'Untracked' }));
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ trackingMode: 'UNTRACKED' }),
    );
  });

  it('saves a newly-entered barcode (issue #52)', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByTestId('item-details-barcode'), {
      target: { value: '4006381333931' },
    });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ barcode: '4006381333931' }),
    );
  });

  it('clears an existing barcode back to null when blanked', () => {
    render(<ItemDetailsEditor item={{ ...item, barcode: '4006381333931' }} />);
    expect((screen.getByTestId('item-details-barcode') as HTMLInputElement).value).toBe('4006381333931');
    fireEvent.change(screen.getByTestId('item-details-barcode'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('item-details-save'));

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(expect.objectContaining({ barcode: null }));
  });

  it('fills the Barcode field from a camera scan', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.click(screen.getByTestId('item-details-barcode-scan'));
    // The stubbed capture dialog hands back a decoded GTIN.
    fireEvent.click(screen.getByTestId('mock-barcode-capture'));
    expect((screen.getByTestId('item-details-barcode') as HTMLInputElement).value).toBe('4006381333931');

    fireEvent.click(screen.getByTestId('item-details-save'));
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ barcode: '4006381333931' }),
    );
  });

  it('keeps unsaved text edits when a unit preference changes (issue #158)', () => {
    render(<ItemDetailsEditor item={item} />);
    // Type unsaved edits across several text fields, then flip the unit preferences — as the
    // Settings rail modal (stacked over this dialog, not unmounting it) does.
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Two paragraphs of hard-won notes' },
    });
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Reworded description' },
    });
    fireEvent.change(screen.getByTestId('item-details-barcode'), { target: { value: '5012345678900' } });

    act(() => usePreferencesStore.getState().setWeightUnit('oz'));
    act(() => usePreferencesStore.getState().setDimensionUnit('in'));

    // None of the text drafts may snap back to their persisted values.
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe(
      'Two paragraphs of hard-won notes',
    );
    expect((screen.getByLabelText('Description (optional)') as HTMLTextAreaElement).value).toBe(
      'Reworded description',
    );
    expect((screen.getByTestId('item-details-barcode') as HTMLInputElement).value).toBe('5012345678900');
  });

  it('re-expresses a stored weight when the weight unit changes (issue #158)', () => {
    // 454 g ≈ 16.01 oz — the field must follow the unit preference for an untouched measurement.
    render(<ItemDetailsEditor item={{ ...item, weight: 454 }} />);
    expect((screen.getByTestId('item-details-weight') as HTMLInputElement).value).toBe('454');

    act(() => usePreferencesStore.getState().setWeightUnit('oz'));
    expect(Number((screen.getByTestId('item-details-weight') as HTMLInputElement).value)).toBeCloseTo(
      16.01,
      1,
    );
  });

  it('keeps unsaved text edits when an unrelated field of the item changes (issue #576)', () => {
    // Every write to an item rebuilds the cached object (`{ ...item, ...changes }`), so a save
    // made in *another* section of the dialog hands this editor a new `item` identity carrying
    // the same core fields. Since the panel now stays mounted behind the rail rather than being
    // unmounted, an identity-keyed re-seed would silently wipe whatever is half-typed here.
    const { rerender } = render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByLabelText('Notes (optional)'), {
      target: { value: 'Half-typed remark' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NE555 timer (renamed)' } });

    // A low-stock save on the Supplier & ops tab: a brand-new object, none of these fields touched.
    rerender(<ItemDetailsEditor item={{ ...item, reorderPoint: 5, updatedAt: 12345 }} />);

    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe(
      'Half-typed remark',
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('NE555 timer (renamed)');
  });

  it('re-seeds the draft when the item’s own persisted values change (a sync landing)', () => {
    const { rerender } = render(<ItemDetailsEditor item={item} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('NE555 timer');

    // A value this editor owns really did change underneath it, so the draft must follow —
    // narrowing the deps must not turn the re-seed off altogether.
    rerender(<ItemDetailsEditor item={{ ...item, name: 'NE555 timer (from sync)' }} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('NE555 timer (from sync)');
  });

  it('shows Tracking read-only for a Serialised item (no in-place conversion)', () => {
    render(<ItemDetailsEditor item={{ ...item, trackingMode: 'SERIALISED' }} />);
    const tracking = screen.getByLabelText('Tracking') as HTMLInputElement;
    expect(tracking.tagName).toBe('INPUT');
    expect(tracking).toHaveProperty('readOnly', true);
    expect(tracking.value).toBe('Serialised');
  });
});
