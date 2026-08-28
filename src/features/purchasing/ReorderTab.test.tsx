/**
 * Component tests for ReorderTab — the currency a quoted price is shown in (issue #569).
 *
 * The plan reaches the tab already denominated (see `reorder-plan.ts`); what is asserted here is
 * that the screen renders each figure under *that* currency rather than the base one, and that a
 * supplier quoting in two currencies is given no total at all.
 *
 * Mocked at the queries boundary so no DB or QueryClient is needed, in the same style as
 * `PurchaseOrdersScreen.test.tsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReorderPlanGroup } from './reorder-plan';
import { ReorderTab } from './ReorderTab';

/** The plan the mocked query hands the tab; set by each test before rendering. */
let planData: readonly ReorderPlanGroup[] = [];

vi.mock('./queries', () => ({
  useReorderPlan: () => ({ isLoading: false, data: planData }),
  useCreateDraftFromReorderPlan: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

// The export menu owns its own download + toast machinery and needs a ToastProvider; the file it
// builds is covered by `reorder-export.test.ts`.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ testIdPrefix }: { testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix}>
      Export
    </button>
  ),
}));

/** Currency-code → symbol for the formatter stub; anything unmapped renders as the base £. */
const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$' };

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number, code?: string) => `${SYMBOLS[code ?? ''] ?? '£'}${v.toFixed(2)}`,
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

/** One supplier group of `lines`, quoted in `currency` (null ⇒ the base currency). */
function group(overrides: Partial<ReorderPlanGroup> & Pick<ReorderPlanGroup, 'lines'>): ReorderPlanGroup {
  return {
    supplierId: 'sup-1',
    supplierName: 'Eurotech',
    supplierKey: 'sup-1',
    currency: null,
    hasMixedCurrency: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  planData = [];
});

describe('ReorderTab — the currency a quote is shown in (issue #569)', () => {
  it("prices a foreign quote under the supplier's own symbol, not the base one", () => {
    planData = [
      group({
        currency: 'EUR',
        lines: [
          {
            itemId: 'i1',
            itemName: 'Imported relay',
            supplierPartId: 'sp1',
            orderQty: 4,
            onOrder: 0,
            unitCost: 12.5,
            currency: 'EUR',
          },
        ],
      }),
    ];
    render(<ReorderTab />);

    // €12.50 each, €50.00 the line, €50.00 the group — never £.
    expect(screen.getByText('€12.50 each')).toBeInTheDocument();
    expect(screen.getByText('€50.00')).toBeInTheDocument();
    expect(screen.getByText('· est. €50.00')).toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
  });

  it('withholds the estimate from a supplier quoting in two currencies', () => {
    planData = [
      group({
        hasMixedCurrency: true,
        lines: [
          {
            itemId: 'i1',
            itemName: 'Imported relay',
            supplierPartId: 'sp1',
            orderQty: 1,
            onOrder: 0,
            unitCost: 12.5,
            currency: 'EUR',
          },
          {
            itemId: 'i2',
            itemName: 'Local bolt',
            supplierPartId: 'sp2',
            orderQty: 1,
            onOrder: 0,
            unitCost: 2,
            currency: null,
          },
        ],
      }),
    ];
    render(<ReorderTab />);

    // No sum exists across the two, so the header says so instead of adding them up.
    expect(screen.getByTestId('reorder-group-mixed-currency')).toBeInTheDocument();
    expect(screen.queryByText(/est\./)).not.toBeInTheDocument();
    // Each line still shows its own price, each under its own currency.
    expect(screen.getByText('€12.50 each')).toBeInTheDocument();
    expect(screen.getByText('£2.00 each')).toBeInTheDocument();
  });

  it('shows a base-currency plan exactly as before', () => {
    planData = [
      group({
        lines: [
          {
            itemId: 'i1',
            itemName: 'Local bolt',
            supplierPartId: 'sp1',
            orderQty: 3,
            onOrder: 0,
            unitCost: 2,
            currency: null,
          },
        ],
      }),
    ];
    render(<ReorderTab />);

    expect(screen.getByText('£2.00 each')).toBeInTheDocument();
    expect(screen.getByText('· est. £6.00')).toBeInTheDocument();
  });
});
