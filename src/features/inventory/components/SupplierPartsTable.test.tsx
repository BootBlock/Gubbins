import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Item, SupplierPart } from '@/db/repositories';

/**
 * Component test for the supplier row's link affordance (issue #518).
 *
 * `supplier_parts.url` is written by the repository, which now refuses a non-`http(s)` address —
 * but the sync/restore path applies remote rows column by column from a snapshot, so a row can
 * still carry anything the peer that sent it chose. The table therefore re-checks the value
 * before it becomes an `href`, and this pins that: a web address is a link, anything else is
 * inert text that says why. Mocked at the hook boundary, with the price-refresh control (which
 * needs a toast provider and the scrape bridge) stubbed out — it is not what is under test.
 */

const h = vi.hoisted(() => ({ parts: [] as SupplierPart[] }));

vi.mock('../queries', () => ({
  useItemSupplierParts: () => ({ data: h.parts }),
  useSupplierPartPriceHistory: () => ({ data: [] }),
}));

vi.mock('../mutations', () => ({
  useCreateSupplierPart: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSupplierPart: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSupplierPart: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPreferredSupplierPart: () => ({ mutate: vi.fn(), isPending: false }),
  useSetSupplierPriceSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('./RefreshPricesButton', () => ({ RefreshPricesButton: () => null }));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    currencyParts: (v: number) => [
      { type: 'currency', value: '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

// Imported after the mocks are registered.
import { SupplierPartsTable } from './SupplierPartsTable';

/** Synthetic, COMPLETE supplier-part fixture (tests are excluded from tsc). */
const part = (overrides: Partial<SupplierPart> = {}): SupplierPart => ({
  id: 'sp-1',
  itemId: 'item-1',
  supplierId: 'sup-1',
  supplierName: 'DigiKey',
  orderCode: null,
  unitCost: null,
  currency: null,
  packQty: null,
  minOrderQty: null,
  priceBreaks: [],
  url: null,
  isPreferred: false,
  isPriceSource: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const item = { id: 'item-1', name: 'Resistor' } as Item;

beforeEach(() => {
  h.parts = [];
});
afterEach(cleanup);

describe('SupplierPartsTable — the product-page link', () => {
  it('renders a web address as an anchor that opens in a new tab', () => {
    h.parts = [part({ url: 'https://example.test/p/1' })];
    render(<SupplierPartsTable item={item} />);

    const anchor = screen.getByRole('link', { name: 'Open' });
    expect(anchor).toHaveAttribute('href', 'https://example.test/p/1');
    expect(anchor).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.queryByTestId('supplier-part-unopenable')).not.toBeInTheDocument();
  });

  it('opens the trimmed address, so what is followed is exactly what was checked', () => {
    h.parts = [part({ url: '  https://example.test/p/1  ' })];
    render(<SupplierPartsTable item={item} />);

    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://example.test/p/1');
  });

  it('shows a stored value that is not a web address as inert text, never an anchor', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/p.html', 'vbscript:msgbox(1)', 'nonsense']) {
      cleanup();
      h.parts = [part({ url })];
      render(<SupplierPartsTable item={item} />);

      expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
      expect(screen.getByTestId('supplier-part-unopenable')).toHaveTextContent('Not a web address');
    }
  });

  it('shows no link affordance at all when the part records no URL', () => {
    h.parts = [part({ url: null })];
    render(<SupplierPartsTable item={item} />);

    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('supplier-part-unopenable')).not.toBeInTheDocument();
  });
});
