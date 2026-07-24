/**
 * Component tests for the insurance / estate schedule screen.
 *
 * The aggregation itself is covered by `insurance-schedule.test.ts` (the pure builder and the
 * totals accumulator) and `ReportRepository.test.ts` (the streamed summary and the paged read);
 * here we prove the presentation wiring, and above all the **print guarantees** from issue #163:
 * the paged reading view is never what prints, an unprepared print is a clearly-headed summary
 * with no item rows, and an over-large schedule refuses to prepare rather than half-printing.
 *
 * Every data hook, the router and the icon set are mocked at the module boundary so the test
 * stays in happy-dom with no providers.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers it.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

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

const GENERATED_AT = Date.parse('2026-07-09T00:00:00Z');

/** One schedule line; each test overrides only what it exercises. */
function line(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    serialNo: null,
    condition: null,
    quantity: 1,
    acquiredAt: null,
    purchasePrice: null,
    warranty: 'none',
    replacementValue: 10,
    thumbnail: null,
    ...overrides,
  };
}

/** Mutable module-scope state so a test can reshape what the hooks return. */
const summaryState: { isLoading: boolean; isError: boolean; data?: unknown } = {
  isLoading: false,
  isError: false,
  data: undefined,
};
const pageState: { isPending: boolean; data?: unknown } = { isPending: false, data: undefined };
const loadFullScheduleLines = vi.fn();
/** happy-dom has no `window.print`, so the screen's call target is supplied outright. */
const printSpy = vi.fn();

vi.mock('./queries', () => ({
  useInsuranceScheduleSummary: () => ({ ...summaryState }),
  useInsuranceSchedulePage: () => ({ ...pageState }),
  useForeignCurrencyCostCount: () => ({ data: 0 }),
  loadFullScheduleLines: (...args: unknown[]) => loadFullScheduleLines(...args),
}));

const { InsuranceScheduleScreen } = await import('./InsuranceScheduleScreen');
const { usePreferencesStore } = await import('@/state/stores/usePreferencesStore');

/** A two-room summary: Garage holds 3 assets, Attic 1. */
function twoRoomSummary(itemCount = 4) {
  return {
    groups: [
      { locationId: 'garage', locationPath: 'Garage', depth: 0, itemCount: itemCount - 1, subtotal: 30 },
      { locationId: 'attic', locationPath: 'Attic', depth: 0, itemCount: 1, subtotal: 10 },
    ],
    grandTotal: 40,
    itemCount,
    generatedAt: GENERATED_AT,
  };
}

beforeEach(() => {
  summaryState.isLoading = false;
  summaryState.isError = false;
  summaryState.data = twoRoomSummary();
  pageState.isPending = false;
  pageState.data = [{ locationId: 'garage', lines: [line('Drill'), line('Saw')] }];
  loadFullScheduleLines.mockReset();
  printSpy.mockReset();
  window.print = printSpy;
  usePreferencesStore.setState({ defaultPageSize: 50 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InsuranceScheduleScreen', () => {
  it('renders the totals from the summary, not from the loaded page', () => {
    // The headline figure covers the whole schedule even though only part of it is on screen —
    // that is the point of reading totals from the bounded summary.
    render(<InsuranceScheduleScreen />);
    expect(screen.getByTestId('schedule-grand-total')).toHaveTextContent('40.00');
    // Both the reading view and the print document state the whole-schedule count.
    expect(screen.getAllByText(/4 assets/).length).toBe(2);
  });

  it('shows a partial room as "showing N of M" rather than a bare count', () => {
    // A bare count beside two of three rows reads as the whole room.
    render(<InsuranceScheduleScreen />);
    expect(screen.getByText(/showing 2 of 3/)).toBeTruthy();
  });

  it('shows a plain count when the whole room is on the page', () => {
    pageState.data = [{ locationId: 'attic', lines: [line('Trunk')] }];
    render(<InsuranceScheduleScreen />);
    expect(screen.queryByText(/showing/)).toBeNull();
    expect(screen.getByText(/1 item/)).toBeTruthy();
  });

  it('reports an error through an alert', () => {
    summaryState.isError = true;
    summaryState.data = undefined;
    render(<InsuranceScheduleScreen />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/i);
  });

  it('says so when there is nothing to schedule', () => {
    summaryState.data = { groups: [], grandTotal: 0, itemCount: 0, generatedAt: GENERATED_AT };
    render(<InsuranceScheduleScreen />);
    expect(screen.getByText(/No catalogued assets/i)).toBeTruthy();
  });

  describe('photos', () => {
    it('leaves photos off by default, with no Photo column', () => {
      render(<InsuranceScheduleScreen />);
      const toggle = screen.getByTestId('schedule-include-photos') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(screen.queryByRole('columnheader', { name: 'Photo' })).toBeNull();
    });

    it('adds the Photo column once photos are turned on', () => {
      render(<InsuranceScheduleScreen />);
      fireEvent.click(screen.getByTestId('schedule-include-photos'));
      expect(screen.getAllByRole('columnheader', { name: 'Photo' }).length).toBeGreaterThan(0);
    });
  });

  describe('printing', () => {
    it('keeps the paged view and the printed document as separate elements', () => {
      // The structural guarantee: the print-only document exists alongside the paged view, so
      // the CSS can hide one and show the other. Both class hooks are load-bearing.
      const { container } = render(<InsuranceScheduleScreen />);
      expect(container.querySelector('.schedule-window')).toBeTruthy();
      expect(container.querySelector('.schedule-print-doc')).toBeTruthy();
    });

    it('prints a clearly-headed summary with no item rows until the full document is prepared', () => {
      render(<InsuranceScheduleScreen />);
      const doc = screen.getByTestId('schedule-print-doc');
      expect(within(doc).getByTestId('schedule-print-heading').textContent).toMatch(
        /Summary — room subtotals only/,
      );
      expect(within(doc).getByText(/Individual assets are not listed/)).toBeTruthy();
      // Room subtotals, yes; individual assets, no.
      expect(within(doc).getByText('Garage')).toBeTruthy();
      expect(within(doc).queryByText('Drill')).toBeNull();
    });

    it('loads every line and then prints once prepare succeeds', async () => {
      loadFullScheduleLines.mockResolvedValue(
        new Map([
          ['garage', [line('Drill'), line('Saw'), line('Vice')]],
          ['attic', [line('Trunk')]],
        ]),
      );
      render(<InsuranceScheduleScreen />);
      fireEvent.click(screen.getByTestId('print-insurance-schedule'));

      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
      const doc = screen.getByTestId('schedule-print-doc');
      expect(within(doc).getByTestId('schedule-print-heading').textContent).toMatch(
        /Full schedule — 4 assets/,
      );
      expect(within(doc).getByText('Vice')).toBeTruthy();
      expect(within(doc).getByText('Trunk')).toBeTruthy();
    });

    it('drops the prepared document on afterprint so its blobs are released', async () => {
      loadFullScheduleLines.mockResolvedValue(new Map([['garage', [line('Drill')]]]));
      render(<InsuranceScheduleScreen />);
      fireEvent.click(screen.getByTestId('print-insurance-schedule'));
      await waitFor(() => expect(printSpy).toHaveBeenCalled());

      window.dispatchEvent(new Event('afterprint'));

      await waitFor(() =>
        expect(screen.getByTestId('schedule-print-heading').textContent).toMatch(/Summary/),
      );
    });

    it('refuses to prepare a schedule past the printable ceiling and explains why', () => {
      summaryState.data = twoRoomSummary(25_000);
      render(<InsuranceScheduleScreen />);
      expect((screen.getByTestId('print-insurance-schedule') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('schedule-too-large').textContent).toMatch(/export it as a file/i);
      // The copy points at an export, so the export has to actually be on offer — otherwise the
      // ceiling is a dead end for exactly the inventories this change exists to support.
      expect((screen.getByTestId('export-schedule') as HTMLButtonElement).disabled).toBe(false);
    });

    it('applies the lower ceiling once photos are on', () => {
      // 5,000 assets is fine as text and far too many as images — the limit tracks the cost.
      summaryState.data = twoRoomSummary(5_000);
      render(<InsuranceScheduleScreen />);
      expect((screen.getByTestId('print-insurance-schedule') as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(screen.getByTestId('schedule-include-photos'));
      expect((screen.getByTestId('print-insurance-schedule') as HTMLButtonElement).disabled).toBe(true);
    });

    it('reports a cancelled preparation without printing', async () => {
      loadFullScheduleLines.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      render(<InsuranceScheduleScreen />);
      fireEvent.click(screen.getByTestId('print-insurance-schedule'));

      await waitFor(() => expect(screen.getByText(/was cancelled/i)).toBeTruthy());
      expect(printSpy).not.toHaveBeenCalled();
    });

    it('reports a failed preparation without printing', async () => {
      loadFullScheduleLines.mockRejectedValue(new Error('boom'));
      render(<InsuranceScheduleScreen />);
      fireEvent.click(screen.getByTestId('print-insurance-schedule'));

      await waitFor(() => expect(screen.getByText(/could not be prepared/i)).toBeTruthy());
      expect(printSpy).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('keeps the main landmark and its skip-link target', () => {
      const { container } = render(<InsuranceScheduleScreen />);
      expect(container.querySelector('main#main-content')).toBeTruthy();
    });

    it('labels the photo toggle and announces print progress in a live region', () => {
      const { container } = render(<InsuranceScheduleScreen />);
      expect(screen.getByText('Include photos')).toBeTruthy();
      expect(container.querySelector('[aria-live]')).toBeTruthy();
    });
  });
});
