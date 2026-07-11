import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
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

  it('shows Tracking read-only for a Serialised item (no in-place conversion)', () => {
    render(<ItemDetailsEditor item={{ ...item, trackingMode: 'SERIALISED' }} />);
    const tracking = screen.getByLabelText('Tracking') as HTMLInputElement;
    expect(tracking.tagName).toBe('INPUT');
    expect(tracking).toHaveProperty('readOnly', true);
    expect(tracking.value).toBe('Serialised');
  });
});
