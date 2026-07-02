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

  it('refuses to save a blank name', () => {
    render(<ItemDetailsEditor item={item} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByTestId('item-details-save')).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toMatch(/enter a name/i);
  });
});
