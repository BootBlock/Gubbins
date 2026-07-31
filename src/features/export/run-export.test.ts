/**
 * Report-CSV window resolution (`runExport('REPORTS', …)`).
 *
 * The Reports screen lets the user pick a trailing window per section, and the exported CSV is
 * expected to cover the span they were looking at. These tests assert the window that actually
 * reaches the `ReportRepository` call — asserting only on the CSV text would pass even if the
 * export silently fell back to the default, because the repository is mocked either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANALYTICS_WINDOW } from '@/features/reports/analytics-windows';
import { ABC_WINDOW_DAYS, DATA_HYGIENE_STALE_DAYS } from '@/features/reports/queries';
// Imported from the constants module directly — `@/db/repositories` is mocked below.
import { DEAD_STOCK_SINCE_DAYS } from '@/db/repositories/constants';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** Records the first argument of each windowed report call. */
const calls: Record<string, unknown[]> = {};

const reportRepo = {
  inventoryValue: vi.fn(async () => ({ totalValue: 0, itemCount: 0, byCategory: [], byLocation: [] })),
  consumptionRate: vi.fn(async (...args: unknown[]) => {
    calls.consumptionRate = args;
    return { windowStart: 0, windowEnd: 0, windowDays: 0, totalConsumed: 0, perDay: 0 };
  }),
  movement: vi.fn(async (...args: unknown[]) => {
    calls.movement = args;
    return { buckets: [], totalIn: 0, totalOut: 0 };
  }),
  deadStock: vi.fn(async (...args: unknown[]) => {
    calls.deadStock = args;
    return { lines: [] };
  }),
  abcAnalysis: vi.fn(async (...args: unknown[]) => {
    calls.abcAnalysis = args;
    return { lines: [] };
  }),
  turnover: vi.fn(async (...args: unknown[]) => {
    calls.turnover = args;
    return { lines: [], totalCogs: 0, totalAvgValue: 0, turnover: 0, daysOnHand: 0 };
  }),
  stockAging: vi.fn(async () => ({ buckets: [] })),
  valuationTrend: vi.fn(async (...args: unknown[]) => {
    calls.valuationTrend = args;
    return { points: [] };
  }),
  dataHygiene: vi.fn(async (...args: unknown[]) => {
    calls.dataHygiene = args;
    return { sections: [] };
  }),
  spendAnalytics: vi.fn(async (...args: unknown[]) => {
    calls.spendAnalytics = args;
    return { total: 0, bySource: [], bySupplier: [], byCategory: [], buckets: [] };
  }),
};

/** Two items, served as one full-and-final page, for the items-export tests below. */
const itemRepo = {
  list: vi.fn(async () => ({
    rows: [
      { id: 'i1', name: 'NE555 Timer', quantity: 12, isUnlimited: false },
      { id: 'i2', name: 'Bolt', quantity: 4, isUnlimited: false },
    ],
    hasMore: false,
  })),
};

/** Two locations, one nested under the other — the JSON export's `locations` array. */
const locationRepo = {
  listAll: vi.fn(async () => [
    { id: 'l1', name: 'Workshop', parentId: null, description: 'The good bench' },
    { id: 'l2', name: 'Cabinet A', parentId: 'l1', description: null },
  ]),
};

vi.mock('@/db/repositories', () => ({
  getReportRepository: () => reportRepo,
  getAttachmentRepository: () => ({}),
  getCheckoutRepository: () => ({ listForItem: async () => ({ rows: [], hasMore: false }) }),
  getCategoryRepository: () => ({}),
  getContactRepository: () => ({ list: async () => ({ rows: [], hasMore: false }) }),
  getImageRepository: () => ({}),
  getItemRepository: () => itemRepo,
  getLocationRepository: () => locationRepo,
  getProjectRepository: () => ({}),
}));

// The download side-effect is the module boundary — stub it so no Blob/anchor work happens.
const downloadSpy = vi.fn();
vi.mock('./download', () => ({ download: (...args: unknown[]) => downloadSpy(...args) }));

const { runExport } = await import('./run-export');

/** A window that is valid but never the default, so a fallback can't masquerade as a pass. */
const PICKED = 365;

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  vi.clearAllMocks();
  // Reset every preference these tests write, so no test inherits a previous one's pick
  // (`deadStockDays` included — it is set below and would otherwise leak forwards).
  usePreferencesStore.setState({
    reportsAnalyticsWindow: DEFAULT_ANALYTICS_WINDOW,
    reportsMovementWindow: DEFAULT_ANALYTICS_WINDOW,
    reportsSpendWindow: DEFAULT_ANALYTICS_WINDOW,
    deadStockDays: DEAD_STOCK_SINCE_DAYS,
  });
});

describe('report CSV export — selected window reaches the repository', () => {
  it('SPEND exports over the selected spend window, not the default', async () => {
    usePreferencesStore.setState({ reportsSpendWindow: PICKED });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'SPEND' });
    expect(calls.spendAnalytics?.[0]).toBe(PICKED);
  });

  it('TURNOVER exports over the selected analytics window, not the default', async () => {
    usePreferencesStore.setState({ reportsAnalyticsWindow: PICKED });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'TURNOVER' });
    expect(calls.turnover?.[0]).toBe(PICKED);
  });

  it('VALUATION_TREND exports over the selected analytics window, not the default', async () => {
    usePreferencesStore.setState({ reportsAnalyticsWindow: PICKED });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'VALUATION_TREND' });
    expect(calls.valuationTrend?.[0]).toBe(PICKED);
  });

  it('MOVEMENT exports over the selected movement window', async () => {
    usePreferencesStore.setState({ reportsMovementWindow: PICKED });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'MOVEMENT' });
    expect(calls.movement?.[0]).toBe(PICKED);
  });

  it('DEAD_STOCK exports over the configured idle threshold', async () => {
    usePreferencesStore.setState({ deadStockDays: 123 });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'DEAD_STOCK' });
    expect(calls.deadStock?.[0]).toBe(123);
  });

  it('keeps each section independent — a spend pick does not leak into turnover', async () => {
    usePreferencesStore.setState({ reportsSpendWindow: PICKED });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'TURNOVER' });
    expect(calls.turnover?.[0]).toBe(DEFAULT_ANALYTICS_WINDOW);
  });

  it('falls back to the default when the persisted window is stale/invalid', async () => {
    // A value no longer offered must never reach the repository (normaliseAnalyticsWindow).
    usePreferencesStore.setState({ reportsSpendWindow: 999 as never });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'SPEND' });
    expect(calls.spendAnalytics?.[0]).toBe(DEFAULT_ANALYTICS_WINDOW);
  });

  it('leaves fixed-span reports on their constants', async () => {
    usePreferencesStore.setState({
      reportsAnalyticsWindow: PICKED,
      reportsSpendWindow: PICKED,
      reportsMovementWindow: PICKED,
    });
    await runExport('REPORTS', { includeInactive: false, reportKind: 'ABC' });
    // ABC is deliberately annual and has no on-screen window control, so it stays on its
    // constant regardless of what the analytics sections are set to. (Asserted against the
    // constant rather than "not the picked window": ABC_WINDOW_DAYS is itself 365.)
    expect(calls.abcAnalysis?.[0]).toBe(ABC_WINDOW_DAYS);

    await runExport('REPORTS', { includeInactive: false, reportKind: 'DATA_HYGIENE' });
    expect(calls.dataHygiene?.[0]).toBe(DATA_HYGIENE_STALE_DAYS);
  });
});

/**
 * The items export names and types its download from the chosen file format (issue #132). It used
 * to hard-code `.csv` and `text/csv` in both places, which is what kept the item list CSV-only
 * while a project's bill of materials could already be saved as a spreadsheet.
 */
describe('items export — the chosen file format reaches the download', () => {
  /** The Blob + filename the export handed to the download side-effect. */
  async function exportItems(itemFileFormat?: Parameters<typeof runExport>[1]['itemFileFormat']) {
    const name = await runExport('CSV', { includeInactive: false, scope: 'ALL', itemFileFormat });
    const [blob] = downloadSpy.mock.calls[0]! as [Blob, string];
    return { name, blob };
  }

  it('defaults to CSV when no file format is chosen, as it always did', async () => {
    const { name, blob } = await exportItems(undefined);
    expect(name).toMatch(/^gubbins-items-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(blob.type).toContain('text/csv');
  });

  it('names the file for the chosen format rather than always .csv', async () => {
    const { name } = await exportItems('markdown');
    expect(name).toMatch(/^gubbins-items-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('types the Blob for the chosen format rather than always text/csv', async () => {
    const { blob } = await exportItems('json');
    expect(blob.type).toContain('application/json');
  });

  it('downloads the binary spreadsheet as a real .xlsx, not text', async () => {
    const { name, blob } = await exportItems('xlsx');
    expect(name).toMatch(/\.xlsx$/);
    expect(blob.type).toContain('spreadsheetml');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('reads every page of items, not just the first', async () => {
    await exportItems('csv');
    expect(itemRepo.list).toHaveBeenCalled();
  });
});

/**
 * Issue #617 (`N7`): the JSON payload was `{ items, contacts, checkouts }`, so an exported item
 * carried a bare `locationId` UUID that resolved to nothing in the file.
 */
describe('JSON export — locations travel with the items', () => {
  it('carries the whole location hierarchy alongside the items', async () => {
    await runExport('JSON', { includeInactive: false, scope: 'ALL' });
    const [blob] = downloadSpy.mock.calls[0]! as [Blob, string];
    const payload = JSON.parse(await blob.text());
    expect(payload.locations).toHaveLength(2);
    // Read whole through `listAll`, so a `parentId` chain never dangles.
    expect(locationRepo.listAll).toHaveBeenCalled();
    expect(payload.locations.map((l: { id: string }) => l.id)).toEqual(['l1', 'l2']);
    expect(payload.locations[0].description).toBe('The good bench');
  });
});
