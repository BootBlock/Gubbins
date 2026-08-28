/**
 * Component tests for the parts-catalogue screen (issue #22). The aggregation itself is
 * exhaustively covered by `parts-catalogue.test.ts` (the pure line + summary seams) and
 * `ReportRepository.test.ts` (the SQL scopes, the grouped totals and the paged reads); here we
 * prove the presentation wiring — the default columns render, the column picker adds/removes
 * columns, the totals footer appears with the costed column — and the **print guarantees** from
 * issue #410: the paged reading view is never what prints, and an unprepared print is a
 * clearly-headed section-subtotal summary with no item rows.
 *
 * Every data hook, the router and the icon set are mocked at the module boundary so the test
 * stays in happy-dom with no providers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

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
    calendarDate: () => '09 Jul 2026',
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

/** The one priced line the fixture document holds, under the Garage section. */
const WIDGET = {
  id: 'widget',
  name: 'Widget',
  locationId: 'garage',
  category: 'Hardware',
  description: 'A test widget',
  thumbnail: null,
  quantity: 3,
  unitOfMeasure: null,
  measured: false,
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
};

/** The bounded summary read: one section, one line, priced — so the totals show. */
const summaryState: { isError: boolean; data?: Record<string, unknown> } = {
  isError: false,
  data: {
    groups: [
      {
        groupId: 'garage',
        groupLabel: 'Garage',
        depth: 0,
        itemCount: 1,
        subtotal: 6,
        totalQuantity: 3,
        ref: { kind: 'location', locationId: 'garage' },
      },
    ],
    grandTotal: 6,
    totalQuantity: 3,
    itemCount: 1,
    hasValue: true,
    generatedAt: Date.parse('2026-07-09T00:00:00Z'),
  },
};

/** One page of lines, as the screen's paged read returns them (one slice per section). */
const pageState: { isPending: boolean; data?: unknown } = {
  isPending: false,
  data: [{ groupId: 'garage', lines: [WIDGET] }],
};

/** The arguments the screen last passed to the paged read, so its wiring is testable. */
let pageArgs: unknown[] = [];
/** Spied so a test can prove the Print button loads the *whole* document before printing. */
const loadFull = vi.fn(async () => new Map([['garage', [WIDGET]]]));

vi.mock('./queries', () => ({
  usePartsCatalogueSummary: () => ({ ...summaryState }),
  usePartsCataloguePage: (...args: unknown[]) => {
    pageArgs = args;
    return { ...pageState };
  },
  loadFullCatalogueLines: (...args: unknown[]) => loadFull(...(args as [])),
}));

// Spied so a test can prove the screen only pays for the QR codes a page actually shows.
const qrSvgOrNull = vi.fn(() => '<svg />');
vi.mock('@/features/scanner/qr-code', () => ({ qrSvgOrNull: (...a: unknown[]) => qrSvgOrNull(...a) }));

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
  (summaryState.data as { itemCount: number }).itemCount = 1;
  summaryState.isError = false;
  pageArgs = [];
  loadFull.mockClear();
  qrSvgOrNull.mockClear();
});

describe('CatalogueScreen', () => {
  it('renders the default columns, the item, and the value totals', () => {
    render(<CatalogueScreen />);

    // Default columns (name is always first).
    const table = within(screen.getByTestId('catalogue-window')).getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Item', 'Category', 'Qty', 'Unit cost', 'Line value']);

    expect(within(screen.getByTestId('catalogue-window')).getByText('Widget')).toBeTruthy();
    // The costed column drives a grand-total; £6.00 appears (formatter mock).
    expect(within(screen.getByTestId('catalogue-window')).getByTestId('catalogue-grand-total')).toBeTruthy();
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
    expect(screen.getAllByTestId('catalogue-grand-total').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('catalogue-field-lineValue'));

    expect(screen.queryAllByTestId('catalogue-grand-total')).toHaveLength(0);
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
    expect(screen.getAllByTestId('catalogue-title')[0]!.textContent).toBe('Catalogue');
  });

  it('shows the total quantity in the grand totals', () => {
    render(<CatalogueScreen />);
    const window_ = screen.getByTestId('catalogue-window');
    expect(within(window_).getByTestId('catalogue-total-quantity').textContent).toContain('3');
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

    const printDoc = within(screen.getByTestId('catalogue-print-doc'));
    expect(printDoc.getByTestId('catalogue-org-name').textContent).toBe('Acme Ltd');
    expect(printDoc.getByTestId('catalogue-title').textContent).toBe('Spare Parts');
  });

  it('falls back to the "Catalogue" title and can hide the generated date', () => {
    render(<CatalogueScreen />);
    // Default: no title override → "Catalogue"; generated date shown.
    expect(screen.getAllByTestId('catalogue-title')[0]!.textContent).toBe('Catalogue');
    expect(document.body.textContent).toContain('Generated');

    cleanup();
    usePreferencesStore.setState({ catalogueShowGeneratedDate: false });
    render(<CatalogueScreen />);
    expect(document.body.textContent).not.toContain('Generated');
  });

  /**
   * The print guarantees: the size readout that precedes the browser's own dialog (issue #338),
   * and the artefact split that keeps a page of a catalogue off paper (issue #410).
   */
  describe('printing', () => {
    /** happy-dom has no `window.print`, so the screen's one is stubbed to record the call. */
    const stubPrint = () => {
      const print = vi.fn();
      Object.defineProperty(window, 'print', { value: print, configurable: true, writable: true });
      return print;
    };

    /** Swap in a document of `itemCount` lines, restoring the single-line default afterwards. */
    const withLineCount = (itemCount: number) => {
      const data = summaryState.data as { itemCount: number };
      const original = data.itemCount;
      data.itemCount = itemCount;
      return () => {
        data.itemCount = original;
      };
    };

    it('states the item count and page estimate before anything is printed', () => {
      render(<CatalogueScreen />);
      const size = screen.getByTestId('catalogue-print-size').textContent ?? '';
      expect(size).toContain('1 item');
      expect(size).toContain('about 1 printed page');
    });

    it('loads the whole document, then prints, when the job is small', async () => {
      const print = stubPrint();
      render(<CatalogueScreen />);

      fireEvent.click(screen.getByTestId('print-catalogue'));

      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      expect(loadFull).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('catalogue-print-confirm')).toBeNull();
    });

    it('asks first when the job runs to many pages, and prints once confirmed', async () => {
      const restore = withLineCount(4_000);
      const print = stubPrint();
      render(<CatalogueScreen />);

      fireEvent.click(screen.getByTestId('print-catalogue'));
      // The browser's print dialog must not have opened yet — that was the whole complaint.
      expect(print).not.toHaveBeenCalled();
      expect(screen.getByTestId('catalogue-print-confirm')).toBeTruthy();

      fireEvent.click(screen.getByTestId('catalogue-print-confirm'));
      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      // The confirmation is gone by the time the page is printed, so it never reaches paper.
      expect(screen.queryByTestId('catalogue-print-confirm')).toBeNull();
      restore();
    });

    /**
     * The structural guarantee. Nothing derived from the paged reading view may print, because a
     * reader of the paper cannot tell one page of a catalogue from the whole of it. Until the
     * Print button has loaded the full document, the print-only artefact is a section-subtotal
     * summary that says so and lists no items.
     */
    it('prints a clearly-headed summary — never the paged view — until the full document is loaded', async () => {
      render(<CatalogueScreen />);

      const printDoc = screen.getByTestId('catalogue-print-doc');
      expect(screen.getByTestId('catalogue-print-heading').textContent).toContain('Summary');
      // The one item on screen is in the paged view, and in no part of what would print.
      expect(within(printDoc).queryByText('Widget')).toBeNull();
      expect(document.querySelector('.catalogue-window')).toBeTruthy();

      stubPrint();
      fireEvent.click(screen.getByTestId('print-catalogue'));
      await waitFor(() =>
        expect(screen.getByTestId('catalogue-print-heading').textContent).toContain('Full catalogue'),
      );
      expect(within(screen.getByTestId('catalogue-print-doc')).getByText('Widget')).toBeTruthy();
    });

    it('refuses to print a scope over the ceiling, but still lets it be read a page at a time', () => {
      const restore = withLineCount(50_000);
      render(<CatalogueScreen />);

      expect(screen.getByTestId('catalogue-too-large').textContent).toContain('50000');
      expect(screen.getByTestId('print-catalogue').hasAttribute('disabled')).toBe(true);
      // …and the document itself is still there. Reading is paged, so its size no longer bars it.
      expect(screen.getByText('Widget')).toBeTruthy();
      restore();
    });

    it('encodes a QR code for each line on the page, not for each line in the scope', () => {
      // The whole-document encode this replaced ran once per item in scope before the reader
      // could see anything; a page's worth is bounded by the page size whatever the scope holds.
      const restore = withLineCount(50_000);
      render(<CatalogueScreen />);
      fireEvent.click(screen.getByTestId('catalogue-field-qr'));

      expect(qrSvgOrNull).toHaveBeenCalledTimes(1);
      restore();
    });

    it('lowers the ceiling once a media column is on', () => {
      // 5,000 items is comfortably printable as text, and over the ceiling with QR codes.
      const restore = withLineCount(5_000);
      render(<CatalogueScreen />);
      expect(screen.queryByTestId('catalogue-too-large')).toBeNull();

      fireEvent.click(screen.getByTestId('catalogue-field-qr'));
      expect(screen.getByTestId('catalogue-too-large')).toBeTruthy();
      restore();
    });
  });

  describe('paging', () => {
    it('reads a page through the sections the summary named, and offers the pager', () => {
      render(<CatalogueScreen />);
      // (scope, groups, offset, limit, options) — the sections come from the summary read, so a
      // page can never be addressed against an ordering the headings do not share.
      expect(pageArgs[1]).toBe((summaryState.data as { groups: unknown }).groups);
      expect(pageArgs[2]).toBe(0);
    });

    it('offers the pager once the document runs to more than one page', () => {
      const data = summaryState.data as { itemCount: number };
      data.itemCount = 500;
      render(<CatalogueScreen />);
      expect(screen.getByTestId('catalogue-pagination')).toBeTruthy();
    });

    it('says so when a section is only partly on the page', () => {
      const groups = (summaryState.data as { groups: { itemCount: number }[] }).groups;
      const original = groups[0]!.itemCount;
      groups[0]!.itemCount = 9; // …of which one line is on this page
      render(<CatalogueScreen />);

      // A bare "9 items" beside a single row would read as the whole section.
      expect(document.body.textContent).toContain('showing 1 of 9');
      groups[0]!.itemCount = original;
    });
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
