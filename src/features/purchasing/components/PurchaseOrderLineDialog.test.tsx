/**
 * Behaviour tests for {@link PurchaseOrderLineDialog} — price breaks in the Order process
 * (issue #37). These pin the quantity-aware costing that is the risk surface: the unit-cost field
 * defaulting from the chosen item, tracking the applicable supplier price-break as the ordered
 * quantity changes, the clickable break tiers, a manual override winning outright, and a
 * hand-typed cost pinning the field.
 *
 * The dialog reads the chosen item and its supplier parts itself (issue #484 — the picker now
 * searches the whole catalogue, so pricing follows the choice rather than being assembled
 * up-front for a fixed first page of it), so those two reads are stubbed here alongside the
 * picker's own catalogue read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item, PriceBreak, SupplierPart, TrackingMode } from '@/db/repositories';

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

/** The catalogue the picker browses, and each item's supplier parts, as this suite has staged them. */
const h = vi.hoisted(() => ({
  items: [] as { id: string; name: string }[],
  parts: new Map<string, unknown[]>(),
}));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({ data: { pages: [{ rows: h.items, hasMore: false }] } }),
  // Nothing is typed into the picker in these tests, so only the browse read answers.
  useItemRelevanceSearch: () => ({ data: undefined }),
  useItem: (id?: string) => ({ data: h.items.find((i) => i.id === id) }),
  useItemSupplierParts: (id?: string) => ({ data: h.parts.get(id ?? '') ?? [] }),
}));

import { PurchaseOrderLineDialog } from './PurchaseOrderLineDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const onSubmit = vi.fn();
const onClose = vi.fn();

/** An item plus the supplier parts the dialog prices it from. */
interface Fixture {
  readonly item: Item;
  readonly parts: readonly SupplierPart[];
}

function fixture(o: {
  id: string;
  name: string;
  trackingMode?: TrackingMode;
  /** The manual item-level valuation override, which wins over supplier pricing. */
  unitCost?: number | null;
  supplierUnitCost?: number | null;
  priceBreaks?: readonly PriceBreak[];
  currency?: string | null;
}): Fixture {
  return {
    item: {
      id: o.id,
      name: o.name,
      serialNo: null,
      unitCost: o.unitCost ?? null,
      trackingMode: o.trackingMode ?? 'DISCRETE',
    } as Item,
    parts: [
      {
        isPreferred: true,
        unitCost: o.supplierUnitCost ?? null,
        priceBreaks: o.priceBreaks ?? [],
        currency: o.currency ?? null,
      } as SupplierPart,
    ],
  };
}

/** A part priced flat at 0.10 with 10+ and 100+ quantity price-breaks. */
const withBreaks = fixture({
  id: 'i1',
  name: 'Resistor 10k',
  supplierUnitCost: 0.1,
  priceBreaks: [
    { qty: 10, unitCost: 0.09 },
    { qty: 100, unitCost: 0.075 },
  ],
});

/** A part with a manual valuation override that must win over the supplier's breaks. */
const overridden = fixture({
  id: 'i2',
  name: 'Capacitor',
  unitCost: 0.5,
  supplierUnitCost: 0.1,
  priceBreaks: [{ qty: 100, unitCost: 0.075 }],
});

function renderDialog(items: Fixture[] = [withBreaks], orderCurrency: string | null = null) {
  h.items = items.map((f) => f.item);
  h.parts = new Map(items.map((f) => [f.item.id, [...f.parts]]));
  return render(
    <PurchaseOrderLineDialog
      open
      orderCurrency={orderCurrency}
      isSaving={false}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
}

const qtyInput = () => screen.getByTestId('po-line-qty');
const costInput = () => screen.getByTestId('po-line-cost') as HTMLInputElement;

/** Open the picker's list and accept an option — the APG combobox commits on mousedown. */
function selectItem(name: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));
  fireEvent.mouseDown(screen.getByRole('option', { name }));
}

beforeEach(() => {
  onSubmit.mockReset();
  onClose.mockReset();
  // The base currency is locale-guessed by default; pin it so "is this quote foreign?" is
  // deterministic rather than dependent on the machine running the suite.
  usePreferencesStore.setState({ baseCurrency: 'GBP' });
});
afterEach(cleanup);

describe('PurchaseOrderLineDialog — quantity price breaks (issue #37)', () => {
  it('defaults the unit cost from the chosen item at the initial quantity', () => {
    renderDialog();
    selectItem('Resistor 10k');
    // qty defaults to 1, below the first break → the flat 0.10 price.
    expect(costInput().value).toBe('0.1');
  });

  it('lowers the unit cost as the quantity reaches a supplier price-break', () => {
    renderDialog();
    selectItem('Resistor 10k');

    fireEvent.change(qtyInput(), { target: { value: '10' } });
    expect(costInput().value).toBe('0.09');

    fireEvent.change(qtyInput(), { target: { value: '250' } });
    expect(costInput().value).toBe('0.075');
  });

  it('renders the break tiers and jumps the quantity when one is clicked', () => {
    renderDialog();
    selectItem('Resistor 10k');

    expect(screen.getByTestId('po-line-price-breaks')).toBeTruthy();
    // Includes the flat qty-1 tier plus each break → three tiers.
    expect(screen.getAllByTestId('po-line-price-break')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /Order 100 or more/ }));
    expect((qtyInput() as HTMLInputElement).value).toBe('100');
    expect(costInput().value).toBe('0.075');
  });

  it('marks the active tier for the current quantity via aria-pressed', () => {
    renderDialog();
    selectItem('Resistor 10k');
    fireEvent.change(qtyInput(), { target: { value: '50' } });
    // 50 sits in the 10+ band, so the 10+ tier is the active (pressed) one.
    const activeTier = screen.getByRole('button', { name: /Order 10 or more/ });
    expect(activeTier.getAttribute('aria-pressed')).toBe('true');
    const inactiveTier = screen.getByRole('button', { name: /Order 100 or more/ });
    expect(inactiveTier.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not duplicate the qty-1 tier when a break already starts at qty 1', () => {
    const breakAtOne = fixture({
      id: 'i3',
      name: 'Fuse',
      supplierUnitCost: 0.1,
      priceBreaks: [
        { qty: 1, unitCost: 0.09 },
        { qty: 100, unitCost: 0.06 },
      ],
    });
    renderDialog([breakAtOne]);
    selectItem('Fuse');
    // The flat qty-1 price is superseded by the 1+ break → two tiers, not three, and no
    // duplicate qty-1 row.
    const rows = screen.getAllByTestId('po-line-price-break');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Order 1 or more/ })).toHaveLength(1);
  });

  it('a manual item override wins over supplier pricing and hides the break tiers', () => {
    renderDialog([overridden]);
    selectItem('Capacitor');
    expect(costInput().value).toBe('0.5');
    expect(screen.queryByTestId('po-line-price-breaks')).toBeNull();

    // Changing the quantity does not disturb the override.
    fireEvent.change(qtyInput(), { target: { value: '1000' } });
    expect(costInput().value).toBe('0.5');
  });

  it('stops auto-filling once the user types their own unit cost', () => {
    renderDialog();
    selectItem('Resistor 10k');

    fireEvent.change(costInput(), { target: { value: '0.99' } });
    fireEvent.change(qtyInput(), { target: { value: '250' } });
    // The hand-typed cost stands even though the quantity now reaches a cheaper break.
    expect(costInput().value).toBe('0.99');
  });

  it('resets the form to defaults when the dialog is reopened', () => {
    // The parent keeps this dialog mounted and only toggles `open`, so without an explicit
    // reset the previous line's values would still be populated on the next open.
    const { rerender } = renderDialog();
    selectItem('Resistor 10k');
    fireEvent.change(screen.getByTestId('po-line-description'), { target: { value: 'A note' } });
    fireEvent.change(qtyInput(), { target: { value: '250' } });
    fireEvent.change(costInput(), { target: { value: '0.99' } });
    expect(costInput().value).toBe('0.99');
    expect(screen.getByTestId('po-line-price-breaks')).toBeTruthy();

    // Close, then reopen — the reset fires on the closed→open edge.
    const props = { orderCurrency: null, isSaving: false, onSubmit, onClose };
    rerender(<PurchaseOrderLineDialog open={false} {...props} />);
    rerender(<PurchaseOrderLineDialog open {...props} />);

    // Every field is back to its initial default, not the previous line's values.
    expect((qtyInput() as HTMLInputElement).value).toBe('1');
    expect(costInput().value).toBe('');
    expect((screen.getByTestId('po-line-description') as HTMLInputElement).value).toBe('');
    // The item is unlinked again — the picker is empty and its break tiers no longer show.
    expect((screen.getByTestId('po-line-item') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('po-line-price-breaks')).toBeNull();
  });

  it('submits the resolved order quantity and unit cost', () => {
    renderDialog();
    selectItem('Resistor 10k');
    fireEvent.change(qtyInput(), { target: { value: '100' } });
    fireEvent.submit(screen.getByTestId('po-line-form'));

    expect(onSubmit).toHaveBeenCalledWith({
      itemId: 'i1',
      description: null,
      orderedQty: 100,
      unitCost: 0.075,
    });
  });
});

describe('PurchaseOrderLineDialog — supplier/order currency mismatch (issue #285)', () => {
  /** The same part, but quoted by a supplier who prices in euros. */
  const euroQuoted: Fixture = {
    item: withBreaks.item,
    parts: withBreaks.parts.map((p) => ({ ...p, currency: 'EUR' })),
  };

  it('warns, and refuses to auto-fill the cost, when the quote is in another currency', () => {
    // A line stores a bare number read as the order's currency, so copying €0.10 into a GBP
    // order would record "0.10 GBP" — wrong by the exchange rate, with no rate to convert by.
    renderDialog([euroQuoted], 'GBP');
    selectItem('Resistor 10k');

    const notice = screen.getByTestId('po-line-currency-mismatch');
    expect(notice.textContent).toContain('EUR');
    expect(notice.textContent).toContain('GBP');
    expect(costInput().value).toBe('');
  });

  it('treats an order with no code of its own as the base currency', () => {
    // Blank means base (GBP here), so a EUR quote is still foreign to it.
    renderDialog([euroQuoted], null);
    selectItem('Resistor 10k');
    expect(screen.getByTestId('po-line-currency-mismatch')).toBeTruthy();
    expect(costInput().value).toBe('');
  });

  it('stays quiet and auto-fills as usual when both sides name the same currency', () => {
    renderDialog([euroQuoted], 'EUR');
    selectItem('Resistor 10k');
    expect(screen.queryByTestId('po-line-currency-mismatch')).toBeNull();
    expect(costInput().value).toBe('0.1');
  });

  it('shows no warning before an item is chosen', () => {
    // The warning is about the chosen supplier's quote; with nothing chosen there is none.
    renderDialog([euroQuoted], 'GBP');
    expect(screen.queryByTestId('po-line-currency-mismatch')).toBeNull();
  });

  it('keeps a hand-entered cost when a price-break tier is clicked', () => {
    // The tier click releases the field back to auto-fill so the tier's price applies — but on a
    // mismatch there is no price to apply, so releasing it would erase the user's figure instead.
    renderDialog([euroQuoted], 'GBP');
    selectItem('Resistor 10k');
    fireEvent.change(costInput(), { target: { value: '0.085' } });

    fireEvent.click(screen.getAllByTestId('po-line-price-break')[1]!);

    expect(qtyInput()).toHaveValue('10'); // the quantity still moves to the tier
    expect(costInput().value).toBe('0.085'); // …and their price survives
  });

  it('still lets the user price the line themselves in the order currency', () => {
    // Refusing the auto-fill must not block the line — the user types the converted figure.
    renderDialog([euroQuoted], 'GBP');
    selectItem('Resistor 10k');
    fireEvent.change(costInput(), { target: { value: '0.085' } });
    fireEvent.submit(screen.getByTestId('po-line-form'));

    expect(onSubmit).toHaveBeenCalledWith({
      itemId: 'i1',
      description: null,
      orderedQty: 1,
      unitCost: 0.085,
    });
  });
});

/**
 * Naming the items a receipt cannot move stock for (issue #608). The picker offered every item
 * under a description promising "received stock lands automatically", though only a bulk-tracked
 * item has a counted quantity for it to land in.
 */
describe('PurchaseOrderLineDialog — items with no counted quantity', () => {
  it('names the tracking mode, and says the link moves no stock', () => {
    const wrench = fixture({ id: 'wr', name: 'Torque wrench', trackingMode: 'SERIALISED' });
    renderDialog([withBreaks, wrench]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));

    expect(
      screen.getByRole('option', { name: 'Torque wrench · Serialised — no stock movement' }),
    ).toBeInTheDocument();
    // …and it stays selectable: recording the spend and the supplier against a serialised tool
    // is an ordinary thing to want, and it is only the stock half that cannot happen.
    expect(screen.getByRole('option', { name: /Torque wrench/ })).toBeEnabled();
  });

  it('leaves a bulk item’s label alone', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));
    expect(screen.getByRole('option', { name: withBreaks.item.name })).toBeInTheDocument();
  });
});
