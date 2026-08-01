import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { AssetEditor } from './AssetEditor';

const spies = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../mutations', () => ({
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
}));

// The revaluation panel renders below the asset fields and owns its own queries/mutations; it
// has its own test. Stubbed here so these assertions describe only the asset fields.
vi.mock('./RevaluationEditor', () => ({ RevaluationEditor: () => null }));

afterEach(() => {
  cleanup();
  spies.update.mockReset();
});

const item: Item = {
  id: 'item-1',
  name: 'Bandsaw',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'SERIALISED',
  quantity: 1,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  barcode: null,
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

/** An item that already carries the two figures a bad entry used to wipe. */
const priced: Item = { ...item, purchasePrice: 250, depreciationMonths: 36 };

const price = () => screen.getByTestId('asset-purchase-price');
const months = () => screen.getByTestId('asset-depreciation-months');
const saveButton = () => screen.getByTestId('save-asset');

describe('AssetEditor', () => {
  it('seeds the draft from the item and starts pristine (Save disabled)', () => {
    render(<AssetEditor item={priced} />);
    expect((price() as HTMLInputElement).value).toBe('250');
    expect((months() as HTMLInputElement).value).toBe('36');
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('saves an edited price and term', () => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(price(), { target: { value: '300' } });
    fireEvent.change(months(), { target: { value: '48' } });
    fireEvent.click(saveButton());

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ purchasePrice: 300, depreciationMonths: 48 }),
    );
  });

  it.each([
    ['a negative price', '-250', /negative/i],
    ['a comma-grouped price', '1,250', /number/i],
    ['a comma-decimal price', '250,00', /number/i],
  ])('refuses to save %s instead of erasing the stored one (issue #675)', (_label, typed, message) => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(price(), { target: { value: typed } });

    expect(screen.getByRole('alert').textContent).toMatch(message);
    expect(saveButton()).toHaveProperty('disabled', true);
    fireEvent.click(saveButton());
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('refuses a zero depreciation term instead of switching depreciation off (issue #675)', () => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(months(), { target: { value: '0' } });

    expect(screen.getByRole('alert').textContent).toMatch(/above zero/i);
    expect(saveButton()).toHaveProperty('disabled', true);
    fireEvent.click(saveButton());
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('marks the unusable field invalid and describes the error to it', () => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(price(), { target: { value: '1,250' } });

    const control = screen.getByLabelText('Purchase price');
    const alert = screen.getByRole('alert');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('blocks the whole save while one field is unusable, so a good sibling edit cannot land', () => {
    // The save is wholesale — letting the acquisition date through would write the parsed
    // price alongside it, which is exactly how the figure used to disappear.
    render(<AssetEditor item={priced} />);
    fireEvent.change(screen.getByTestId('asset-acquired-at'), { target: { value: '2026-01-31' } });
    fireEvent.change(price(), { target: { value: '-250' } });
    fireEvent.click(saveButton());

    expect(spies.update).not.toHaveBeenCalled();
  });

  it('still clears a stored price or term when the field is deliberately blanked', () => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(price(), { target: { value: '' } });
    fireEvent.change(months(), { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(saveButton());
    expect(spies.update.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ purchasePrice: null, depreciationMonths: null }),
    );
  });

  it('truncates a fractional term to whole months, as the repository does', () => {
    render(<AssetEditor item={priced} />);
    fireEvent.change(months(), { target: { value: '18.9' } });
    fireEvent.click(saveButton());

    expect(spies.update.mock.calls[0][0].input).toEqual(expect.objectContaining({ depreciationMonths: 18 }));
  });
});
