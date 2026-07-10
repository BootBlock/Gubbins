/**
 * Component smoke tests for the parts-catalogue screen (issue #22). The aggregation itself is
 * exhaustively covered by `parts-catalogue.test.ts` (the pure builder) and
 * `ReportRepository.test.ts` (the SQL scopes); here we only prove the presentation wiring — the
 * default columns render, the column picker adds/removes columns, and the totals footer appears
 * with the costed column. Every data hook, the router and the icon set are mocked at the module
 * boundary so the test stays in happy-dom with no providers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
}));

vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    currencyParts: (v: number) => [
      { type: 'currency', value: '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    quantity: (v: number) => String(v),
    percent: () => '0%',
    bytes: () => '0B',
    measure: (v: number, u: string) => `${v}${u}`,
    date: () => '09 Jul 2026',
    dateTime: () => '09 Jul 2026, 00:00',
  }),
}));

vi.mock('@/features/inventory/queries', () => ({
  useLocations: () => ({ data: { rows: [{ id: 'garage', name: 'Garage', parentId: null }] } }),
}));

vi.mock('@/features/projects/projects', () => ({
  useProjects: () => ({ data: { rows: [] } }),
}));

vi.mock('@/features/modules/useFeature', () => ({
  useEnabledFeatures: () => new Set(['projects', 'reports']),
}));

// The catalogue query — a single priced line under one location, hasValue so totals show.
const catalogueState: { isLoading: boolean; isError: boolean; data?: unknown } = {
  isLoading: false,
  isError: false,
  data: {
    groups: [
      {
        locationId: 'garage',
        locationPath: 'Garage',
        depth: 0,
        subtotal: 6,
        lines: [
          {
            id: 'widget',
            name: 'Widget',
            category: 'Hardware',
            quantity: 3,
            unitOfMeasure: null,
            condition: null,
            serialNo: null,
            mpn: 'MPN-1',
            manufacturer: null,
            supplier: null,
            unitCost: 2,
            lineValue: 6,
            purchasePrice: null,
            acquiredAt: null,
            warranty: 'none',
            notes: null,
          },
        ],
      },
    ],
    grandTotal: 6,
    itemCount: 1,
    hasValue: true,
    generatedAt: Date.parse('2026-07-09T00:00:00Z'),
  },
};

vi.mock('./queries', () => ({
  usePartsCatalogue: () => ({ ...catalogueState }),
}));

import { CatalogueScreen } from './CatalogueScreen';

afterEach(() => {
  cleanup();
});

describe('CatalogueScreen', () => {
  it('renders the default columns, the item, and the value totals', () => {
    render(<CatalogueScreen />);

    // Default columns (name is always first).
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Item', 'Category', 'Qty', 'Unit cost', 'Line value']);

    expect(screen.getByText('Widget')).toBeTruthy();
    // The costed column drives a grand-total; £6.00 appears (formatter mock).
    expect(screen.getByTestId('catalogue-grand-total')).toBeTruthy();
    // Print is available with data present.
    expect(screen.getByTestId('print-catalogue').hasAttribute('disabled')).toBe(false);
  });

  it('adds a column when its checkbox is ticked', () => {
    render(<CatalogueScreen />);
    expect(screen.queryByRole('columnheader', { name: 'MPN' })).toBeNull();

    fireEvent.click(screen.getByTestId('catalogue-field-mpn'));

    expect(screen.getByRole('columnheader', { name: 'MPN' })).toBeTruthy();
    expect(screen.getByText('MPN-1')).toBeTruthy();
  });

  it('drops the totals when the Line value column is turned off', () => {
    render(<CatalogueScreen />);
    expect(screen.getByTestId('catalogue-grand-total')).toBeTruthy();

    fireEvent.click(screen.getByTestId('catalogue-field-lineValue'));

    expect(screen.queryByTestId('catalogue-grand-total')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Line value' })).toBeNull();
  });
});
