import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { widgetById } from './widgets';
import { BOARD_SINGLE_COLUMN_QUERY, WidgetSizeProvider, listRowCount } from './widget-size';
import type { MediaQueryProvider } from '@/components/foundry';

/**
 * The Low Stock widget surfaces incoming ("on order") stock so a covered shortage reads as
 * "handled", *without* changing what counts as low — the alert stays on-hand-based. The
 * low-stock feed and the batched on-order read are both mocked so this exercises only the
 * widget's rendering of the affordance and the de-emphasis of fully-covered rows.
 */
const spies = vi.hoisted(() => ({ lowStock: vi.fn(), lowStockCount: vi.fn(), onOrder: vi.fn() }));

vi.mock('@/features/lifecycle/hooks', () => ({
  useLowStockItems: () => spies.lowStock(),
}));

// The headline figure is the repository's `COUNT(*)`, not the rows in hand (issue #606). Here it
// answers with the length of the mocked feed, which is what a real count would say for a set this
// small — the two are held to agree on real data by `attention-count-parity.test.ts`.
vi.mock('@/features/reports/queries', () => ({
  useLowStockCount: () => ({
    data: spies.lowStockCount() ?? spies.lowStock().data?.rows.length ?? 0,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('@/features/purchasing/queries', () => ({
  useOnOrderQtys: () => spies.onOrder(),
}));

const baseItem: Item = {
  id: 'item-1',
  name: 'Item',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 2,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  reorderPoint: 10,
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
  isUnlimited: false,
};

/** A low DISCRETE item (qty 2, reorder point 10 → shortfall 8) with a distinct name/id. */
const low = (over: Partial<Item> = {}): Item => ({ ...baseItem, ...over });

const LowStockWidget = widgetById('low-stock')!.Component;

function renderWidget() {
  return render(<LowStockWidget />);
}

beforeEach(() => {
  usePreferencesStore.setState({ lowStockQtyThreshold: 0, lowStockGaugePercent: 0 });
  spies.onOrder.mockReturnValue({ data: new Map<string, number>() });
});

afterEach(() => {
  cleanup();
  spies.lowStock.mockReset();
  spies.lowStockCount.mockReset();
  spies.onOrder.mockReset();
});

describe('LowStockWidget — on-order affordance', () => {
  it('shows a "N on order" affordance for a low item with incoming stock', () => {
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Widget A' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 4]]) });

    renderWidget();
    const badge = screen.getByTestId('low-stock-on-order');
    expect(badge).toHaveTextContent('4 on order');
  });

  it('omits the affordance for a low item with nothing on order', () => {
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Widget A' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map<string, number>() });

    renderWidget();
    expect(screen.queryByTestId('low-stock-on-order')).toBeNull();
    expect(screen.getByText('Widget A')).toBeInTheDocument();
  });

  it('de-emphasises a row fully covered by incoming stock, but keeps it listed and counted', () => {
    // Shortfall is 8 (10 − 2). onOrder 8 fully covers it → the row is dimmed but stays.
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Covered Co' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 8]]) });

    renderWidget();
    const label = screen.getByText('Covered Co');
    // The row remains in the list (the low-stock threshold is untouched by netting)…
    expect(label).toBeInTheDocument();
    // …but is visually de-emphasised (opacity utility on the row container).
    const row = label.closest('div');
    expect(row?.className).toContain('opacity-55');
    // …and still carries the on-order affordance.
    expect(within(row!).getByTestId('low-stock-on-order')).toHaveTextContent('8 on order');
  });

  it('does not de-emphasise a row only partially covered by incoming stock', () => {
    // Shortfall 8, only 3 inbound → still short, so no dimming.
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Partial Co' })] },
      isPending: false,
      isError: false,
    });
    spies.onOrder.mockReturnValue({ data: new Map([['a', 3]]) });

    renderWidget();
    const row = screen.getByText('Partial Co').closest('div');
    expect(row?.className).not.toContain('opacity-55');
    expect(within(row!).getByTestId('low-stock-on-order')).toHaveTextContent('3 on order');
  });

  it('keeps the low-stock count on-hand-based even when every row is fully on order', () => {
    // Three low items, all fully covered by incoming stock — the count still reads 3
    // (the alert never re-nets against on-order), and all three stay listed.
    const rows = [
      low({ id: 'a', name: 'Aaa' }),
      low({ id: 'b', name: 'Bbb' }),
      low({ id: 'c', name: 'Ccc' }),
    ];
    spies.lowStock.mockReturnValue({ data: { rows }, isPending: false, isError: false });
    spies.onOrder.mockReturnValue({
      data: new Map([
        ['a', 8],
        ['b', 8],
        ['c', 8],
      ]),
    });

    renderWidget();
    // The headline count is the number of low items, unaffected by on-order coverage.
    expect(screen.getByText('3')).toBeInTheDocument();
    for (const name of ['Aaa', 'Bbb', 'Ccc']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('states the whole catalogue as the headline, not the page of rows it lists', () => {
    // The tile reads one bounded page and lists three of it, so counting the rows in hand made
    // the headline the page size on any inventory with more than a page of low items (issue
    // #606). Driving the count apart from the feed is what makes that visible here: with the
    // old `rows.length` the tile would read 3.
    spies.lowStock.mockReturnValue({
      data: { rows: [low({ id: 'a', name: 'Aaa' }), low({ id: 'b', name: 'Bbb' })] },
      isPending: false,
      isError: false,
    });
    spies.lowStockCount.mockReturnValue(4231);

    renderWidget();
    expect(screen.getByText('4,231')).toBeInTheDocument();
    expect(screen.queryByText('2')).toBeNull();
  });

  it('renders healthy state (no on-order query fired) when nothing is low', () => {
    spies.lowStock.mockReturnValue({ data: { rows: [] }, isPending: false, isError: false });
    spies.onOrder.mockReturnValue({ data: undefined });

    renderWidget();
    expect(screen.getByText('Stock levels healthy.')).toBeInTheDocument();
    expect(screen.queryByTestId('low-stock-on-order')).toBeNull();
  });
});

/**
 * A card resized on the board has to *show* more, not just take more room (issue #441) — the
 * whole point of the feature. Low Stock stands in for every list widget here: they all read
 * the same `useWidgetSize` seam through the same `useListLayout` helper, so the row budget is
 * covered once and the pure maths is unit-tested in `widget-size.test.ts`.
 */
describe('LowStockWidget — content scales with the tile size', () => {
  /** Twelve low items, enough to overflow every size the board offers. */
  function twelveLowItems() {
    spies.lowStock.mockReturnValue({
      data: {
        rows: Array.from({ length: 12 }, (_, i) => low({ id: `i-${i}`, name: `Item ${i}` })),
      },
      isPending: false,
      isError: false,
    });
  }

  function renderAt(w: number, h: number) {
    return render(
      <WidgetSizeProvider w={w} h={h}>
        <LowStockWidget />
      </WidgetSizeProvider>,
    );
  }

  /** How many item rows the widget drew. */
  function rowCount(): number {
    return screen.getAllByText(/^Item \d+$/).length;
  }

  it('draws the same three rows it always did at the default 1x1 size', () => {
    twelveLowItems();
    renderAt(1, 1);
    expect(rowCount()).toBe(3);
  });

  it('draws more rows in a taller card', () => {
    twelveLowItems();
    renderAt(1, 2);
    expect(rowCount()).toBe(listRowCount({ w: 1, h: 2 }, 3));
    expect(rowCount()).toBeGreaterThan(3);
  });

  it('lays a wider card out in two columns of rows', () => {
    twelveLowItems();
    renderAt(2, 1);
    expect(rowCount()).toBe(6);
    // The rows sit in a two-column grid rather than a single stack.
    expect(screen.getByText('Item 0').closest('.grid-cols-2')).not.toBeNull();
  });

  it('keeps a one-line empty state in a single column however wide the card is', () => {
    spies.lowStock.mockReturnValue({ data: { rows: [] }, isPending: false, isError: false });
    renderAt(2, 2);
    expect(screen.getByText(/Stock levels healthy/).closest('.grid-cols-2')).toBeNull();
  });
});

/**
 * Below the board's breakpoint the dashboard is a single column of full-width cards and the
 * grid placement (and so the span) is not applied at all. The content has to make the same
 * call: a card sized 2x2 on a tablet must not draw twenty-two rows into a phone-width card.
 */
describe('LowStockWidget — a span is ignored on a single-column board', () => {
  /** A `matchMedia` stand-in reporting a viewport narrower than the board's breakpoint. */
  const narrow: MediaQueryProvider = () => ({
    matches: true,
    media: BOARD_SINGLE_COLUMN_QUERY,
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  it('draws its default rows in one column however large the card was made', () => {
    spies.lowStock.mockReturnValue({
      data: { rows: Array.from({ length: 12 }, (_, i) => low({ id: `n-${i}`, name: `Item ${i}` })) },
      isPending: false,
      isError: false,
    });
    render(
      <WidgetSizeProvider w={2} h={2} mediaProvider={narrow}>
        <LowStockWidget />
      </WidgetSizeProvider>,
    );
    expect(screen.getAllByText(/^Item \d+$/)).toHaveLength(3);
    expect(screen.getByText('Item 0').closest('.grid-cols-2')).toBeNull();
  });
});
