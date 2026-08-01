import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { RevaluationEditor } from './RevaluationEditor';

const spies = vi.hoisted(() => ({ record: vi.fn(), update: vi.fn() }));

vi.mock('../mutations', () => ({
  useRecordRevaluation: () => ({ mutate: spies.record, isPending: false }),
  useUpdateItem: () => ({ mutate: spies.update, isPending: false }),
}));

vi.mock('../queries', () => ({
  useItemRevaluations: () => ({ data: [] }),
}));

afterEach(() => {
  cleanup();
  spies.record.mockReset();
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
  purchasePrice: 250,
  depreciationMonths: null,
  currentValue: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};

const amount = () => screen.getByTestId('revaluation-amount');
const recordButton = () => screen.getByTestId('record-revaluation');

describe('RevaluationEditor', () => {
  it('records an entered value', () => {
    render(<RevaluationEditor item={item} />);
    fireEvent.change(amount(), { target: { value: '400' } });
    fireEvent.click(recordButton());

    expect(spies.record).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][0].input).toEqual(expect.objectContaining({ value: 400 }));
  });

  it('stays quiet and unarmed while the field is empty', () => {
    // Nothing typed yet is not an error — the button is simply not ready.
    render(<RevaluationEditor item={item} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(recordButton()).toHaveProperty('disabled', true);
  });

  it('says why an unusable figure is refused rather than leaving the button dead (issue #675)', () => {
    render(<RevaluationEditor item={item} />);
    fireEvent.change(amount(), { target: { value: '1,250' } });

    expect(screen.getByRole('alert').textContent).toMatch(/number/i);
    expect(recordButton()).toHaveProperty('disabled', true);

    // Correcting it clears the error and releases the figure — the recovery the old silent
    // disable gave no route to.
    fireEvent.change(amount(), { target: { value: '1250' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(recordButton());
    expect(spies.record.mock.calls[0][0].input).toEqual(expect.objectContaining({ value: 1250 }));
  });

  it('reports a negative figure the same way', () => {
    render(<RevaluationEditor item={item} />);
    fireEvent.change(amount(), { target: { value: '-5' } });

    expect(screen.getByRole('alert').textContent).toMatch(/negative/i);
    expect(recordButton()).toHaveProperty('disabled', true);
  });
});
