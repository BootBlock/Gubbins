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
        groupId: 'garage',
        groupLabel: 'Garage',
        depth: 0,
        subtotal: 6,
        totalQuantity: 3,
        lines: [
          {
            id: 'widget',
            name: 'Widget',
            locationId: 'garage',
            category: 'Hardware',
            description: 'A test widget',
            thumbnail: null,
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
    totalQuantity: 3,
    itemCount: 1,
    hasValue: true,
    generatedAt: Date.parse('2026-07-09T00:00:00Z'),
  },
};

vi.mock('./queries', () => ({
  usePartsCatalogue: () => ({ ...catalogueState }),
}));

import { CatalogueScreen } from './CatalogueScreen';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCatalogueLaunch } from './useCatalogueLaunch';

/** The letterhead preference defaults — restored between tests so branding never leaks. */
const BRANDING_DEFAULTS = {
  catalogueTitle: '',
  catalogueOrgName: '',
  catalogueOrgDetails: '',
  catalogueFooter: '',
  catalogueLogo: '',
  catalogueShowGeneratedDate: true,
  cataloguePageNumbers: true,
  catalogueRunningHeader: true,
  cataloguePaperPreview: false,
  labelBaseUrl: '',
};

afterEach(() => {
  cleanup();
  usePreferencesStore.setState(BRANDING_DEFAULTS);
  useCatalogueLaunch.setState({ pendingScope: null });
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

  it('carries a rich-Markdown help badge on every column and control', () => {
    render(<CatalogueScreen />);
    // One badge per column (13) plus the scope/columns/branding controls — assert at least the
    // 13 per-column badges are present so each column explains its print/don't-print trade-off.
    expect(screen.getAllByRole('img', { name: 'More information' }).length).toBeGreaterThanOrEqual(13);
  });

  it('renders a title of only whitespace as the default "Catalogue"', () => {
    usePreferencesStore.setState({ catalogueTitle: '   ' });
    render(<CatalogueScreen />);
    expect(screen.getByTestId('catalogue-title').textContent).toBe('Catalogue');
  });

  it('shows the total quantity in the grand totals', () => {
    render(<CatalogueScreen />);
    expect(screen.getByTestId('catalogue-total-quantity').textContent).toContain('3');
  });

  it('dresses the preview as white paper when the toggle is on', () => {
    render(<CatalogueScreen />);
    // Off by default — the preview wrapper carries no paper class.
    expect(screen.getByTestId('catalogue-preview').className).not.toContain('catalogue-paper');

    fireEvent.click(screen.getByTestId('catalogue-paper-preview'));
    expect(screen.getByTestId('catalogue-preview').className).toContain('catalogue-paper');
  });

  it('offers group-by and sort-by controls, and a Description column', () => {
    render(<CatalogueScreen />);
    expect(screen.getByTestId('catalogue-group-by')).toBeTruthy();
    expect(screen.getByTestId('catalogue-sort-by')).toBeTruthy();

    expect(screen.queryByRole('columnheader', { name: 'Description' })).toBeNull();
    fireEvent.click(screen.getByTestId('catalogue-field-description'));
    expect(screen.getByRole('columnheader', { name: 'Description' })).toBeTruthy();
    expect(screen.getByText('A test widget')).toBeTruthy();
  });

  it('injects a page-number print style by default and drops it when turned off', () => {
    const { unmount } = render(<CatalogueScreen />);
    const hasPageStyle = () =>
      [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('counter(page)'));
    expect(hasPageStyle()).toBe(true);
    unmount();

    usePreferencesStore.setState({ cataloguePageNumbers: false, catalogueRunningHeader: false });
    render(<CatalogueScreen />);
    expect(hasPageStyle()).toBe(false);
  });

  it('does not print a letterhead line for a whitespace-only company name', () => {
    usePreferencesStore.setState({ catalogueOrgName: '   ' });
    render(<CatalogueScreen />);
    expect(screen.queryByTestId('catalogue-org-name')).toBeNull();
  });

  it('shows "No projects are in the system." in place of the project picker when none exist', () => {
    // Launch the screen already scoped to a project; useProjects is mocked with no rows.
    useCatalogueLaunch.getState().launch({ kind: 'project', projectId: 'p1' });
    render(<CatalogueScreen />);

    expect(screen.getByTestId('catalogue-no-projects').textContent).toBe('No projects are in the system.');
    expect(screen.queryByTestId('catalogue-project')).toBeNull();
  });

  it('stamps the letterhead org name and title override onto the printed document', () => {
    usePreferencesStore.setState({ catalogueOrgName: 'Acme Ltd', catalogueTitle: 'Spare Parts' });
    render(<CatalogueScreen />);

    expect(screen.getByTestId('catalogue-org-name').textContent).toBe('Acme Ltd');
    expect(screen.getByTestId('catalogue-title').textContent).toBe('Spare Parts');
  });

  it('falls back to the "Catalogue" title and can hide the generated date', () => {
    render(<CatalogueScreen />);
    // Default: no title override → "Catalogue"; generated date shown.
    expect(screen.getByTestId('catalogue-title').textContent).toBe('Catalogue');
    expect(document.body.textContent).toContain('Generated');

    cleanup();
    usePreferencesStore.setState({ catalogueShowGeneratedDate: false });
    render(<CatalogueScreen />);
    expect(document.body.textContent).not.toContain('Generated');
  });
});

describe('catalogue letterhead preferences', () => {
  it('store the letterhead text verbatim — a trailing space or a newline is never trimmed away', () => {
    const store = usePreferencesStore.getState();
    // A trailing space must survive (previously trimmed on every keystroke, so it could
    // never be typed at the end of the field).
    store.setCatalogueTitle('Spare Parts ');
    expect(usePreferencesStore.getState().catalogueTitle).toBe('Spare Parts ');
    // A multi-line address must keep its newlines (and any trailing one).
    store.setCatalogueOrgDetails('12 Example Way\nExample Town\n');
    expect(usePreferencesStore.getState().catalogueOrgDetails).toBe('12 Example Way\nExample Town\n');
    store.setCatalogueOrgName(' Acme ');
    expect(usePreferencesStore.getState().catalogueOrgName).toBe(' Acme ');
    store.setCatalogueFooter('© Acme ');
    expect(usePreferencesStore.getState().catalogueFooter).toBe('© Acme ');
  });

  it('still guards the logo to a data:image URL', () => {
    usePreferencesStore.getState().setCatalogueLogo('not-an-image');
    expect(usePreferencesStore.getState().catalogueLogo).toBe('');
    usePreferencesStore.getState().setCatalogueLogo('data:image/webp;base64,AAAA');
    expect(usePreferencesStore.getState().catalogueLogo).toBe('data:image/webp;base64,AAAA');
  });
});
