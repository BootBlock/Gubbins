import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CreateSupplierPartInput } from '@/db/repositories';

/**
 * Behaviour tests for the {@link SupplierPartFormDialog} glue (spec §4 supplier facet, Phase 60).
 * Every numeric field is optional, so the dialog stores strings and coerces on submit — its
 * unexported `parseBreaks` / `optionalCost` / `optionalCount` helpers and the `INVALID`-sentinel
 * error gates ARE the risk surface, and this dialog is their only test surface. Currency is an
 * editable combobox (issue #415): the user may pick a popular currency or free-type any ISO code,
 * and the value is normalised to an upper-cased code — so the test types one. `onSubmit` is a prop
 * (not a mutation hook), so the sole hook to mock is the supplier
 * list the picker reads; this pins the exact {@link CreateSupplierPartInput} the form assembles for
 * the minimal and fully-populated happy paths, the `qty:cost` price-break parsing, and each
 * validation gate that must block submit with a `role="alert"` rather than coerce nonsense to null.
 *
 * The supplier field emits a `SupplierRef` rather than a bare name (issue #384): typing a name is
 * still the low-friction path, and it is resolved to a canonical supplier at write time.
 */

vi.mock('@/features/suppliers/queries', () => ({
  useSuppliers: () => ({ data: { rows: [], hasMore: false }, isLoading: false }),
  supplierKeys: { all: ['suppliers'], list: () => ['suppliers', 'list'] },
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
      supplier: { supplierName: 'DigiKey' }, // trimmed
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
  it('coerces the numbers, trims the text, upper-cases the typed currency, and parses breaks', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByTestId('supplier-part-order-code'), { target: { value: '  ABC-123 ' } });
    fireEvent.change(screen.getByTestId('supplier-part-unit-cost'), { target: { value: '1.50' } });
    // Currency is an editable combobox: typing a lower-case code normalises to the ISO code.
    fireEvent.change(screen.getByTestId('supplier-part-currency'), { target: { value: 'eur' } });
    fireEvent.change(screen.getByLabelText('Pack qty'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Min order qty'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('supplier-part-breaks'), {
      target: { value: '100:0.10\n1000:0.08' },
    });
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith({
      supplier: { supplierName: 'DigiKey' },
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

  it('rejects a URL that is not a full http(s) web address', () => {
    // The value is later rendered as an anchor, so an address a browser cannot navigate to is
    // at best a dead link. Naming it here beats letting the repository's refusal surface as a
    // write error over the table, after the dialog has closed.
    for (const url of ['javascript:alert(1)', 'file:///C:/p.html', 'example.test/p/1']) {
      cleanup();
      onSubmit.mockReset();
      renderDialog();
      fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
      fireEvent.change(screen.getByLabelText('URL'), { target: { value: url } });
      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent(
        'The supplier URL must be a full web address starting with http:// or https://.',
      );
      expect(onSubmit).not.toHaveBeenCalled();
    }
  });

  it('accepts a web address and submits it trimmed', () => {
    renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'DigiKey' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: '  https://example.test/p/1 ' } });
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.test/p/1' }));
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
