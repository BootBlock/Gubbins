import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CreateSupplierPartInput } from '@/db/repositories';

/**
 * Behaviour tests for the {@link SupplierPartFormDialog} glue (spec §4 supplier facet, Phase 60).
 * Every numeric field is optional, so the dialog stores strings and coerces on submit — its
 * unexported `parseBreaks` / `optionalCost` / `optionalCount` / `codeFromCurrencyChoice` helpers
 * and the `INVALID`-sentinel error gates ARE the risk surface, and this dialog is their only test
 * surface. `onSubmit` is a prop (not a mutation hook), so the sole hook to mock is the supplier
 * suggestion query; this pins the exact {@link CreateSupplierPartInput} the form assembles for the
 * minimal and fully-populated happy paths, the `qty:cost` price-break parsing, and each validation
 * gate that must block submit with a `role="alert"` rather than coerce nonsense to null.
 */

vi.mock('../queries', () => ({
  useFieldSuggestions: () => ({ data: [] }),
}));

import { SupplierPartFormDialog } from './SupplierPartFormDialog';

const onSubmit = vi.fn();
const onClose = vi.fn();

function renderDialog() {
  return render(
    <SupplierPartFormDialog open part={null} isSaving={false} onSubmit={onSubmit} onClose={onClose} />,
  );
}

const form = () => screen.getByTestId('supplier-part-form');
const nameInput = () => screen.getByTestId('supplier-part-name');
const submitForm = () => fireEvent.submit(form());

beforeEach(() => {
  onSubmit.mockReset();
  onClose.mockReset();
});
afterEach(cleanup);

describe('SupplierPartFormDialog — the minimal happy path', () => {
  it('submits a name-only part with every optional field nulled and no price breaks', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: '  DigiKey  ' } });
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith({
      supplierName: 'DigiKey', // trimmed
      orderCode: null,
      unitCost: null,
      currency: null,
      packQty: null,
      minOrderQty: null,
      url: null,
      priceBreaks: [],
    } satisfies CreateSupplierPartInput);
  });
});

describe('SupplierPartFormDialog — a fully populated part', () => {
  it('coerces the numbers, trims the text, upper-cases the ISO currency, and parses breaks', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByTestId('supplier-part-order-code'), { target: { value: '  ABC-123 ' } });
    fireEvent.change(screen.getByTestId('supplier-part-unit-cost'), { target: { value: '1.50' } });
    // Currency is typed lower-case; codeFromCurrencyChoice upper-cases it to the ISO code.
    fireEvent.change(screen.getByTestId('supplier-part-currency'), { target: { value: 'eur' } });
    fireEvent.change(screen.getByLabelText('Pack qty'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Min order qty'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('supplier-part-breaks'), {
      target: { value: '100:0.10\n1000:0.08' },
    });
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith({
      supplierName: 'DigiKey',
      orderCode: 'ABC-123',
      unitCost: 1.5,
      currency: 'EUR',
      packQty: 1000,
      minOrderQty: 5,
      url: null,
      priceBreaks: [
        { qty: 100, unitCost: 0.1 },
        { qty: 1000, unitCost: 0.08 },
      ],
    });
  });

  it('drops malformed, blank, and out-of-range price-break lines', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    // Keep: 100:0.10, 1000:0.08. Drop: blank, "bad" (NaN qty), -5:2 (qty ≤ 0), 7:-1 (cost < 0).
    fireEvent.change(screen.getByTestId('supplier-part-breaks'), {
      target: { value: '100:0.10\n\n bad \n1000:0.08\n-5:2\n7:-1' },
    });
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        priceBreaks: [
          { qty: 100, unitCost: 0.1 },
          { qty: 1000, unitCost: 0.08 },
        ],
      }),
    );
  });
});

describe('SupplierPartFormDialog — the validation gates block submit', () => {
  it('requires a supplier name', () => {
    renderDialog();
    submitForm();
    expect(screen.getByTestId('supplier-part-error')).toHaveTextContent('A supplier name is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric unit cost rather than coercing it to null', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByTestId('supplier-part-unit-cost'), { target: { value: 'abc' } });
    submitForm();

    expect(screen.getByRole('alert')).toHaveTextContent('Unit cost must be zero or a positive amount.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a fractional pack quantity (whole numbers only)', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByLabelText('Pack qty'), { target: { value: '1.5' } });
    submitForm();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pack quantity must be a whole number greater than zero.',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a zero minimum order quantity', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByLabelText('Min order qty'), { target: { value: '0' } });
    submitForm();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Minimum order quantity must be a whole number greater than zero.',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
