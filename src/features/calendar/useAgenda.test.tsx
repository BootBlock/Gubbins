/**
 * Hook-wiring tests for `useAgenda` feature gating (Modular UI Phase 7).
 *
 * The pure `buildAgenda` seam is covered in `agenda.test.ts`; here we verify the hook's
 * deep-cascade wiring: each date-driven lane gates on its owning feature (bookings→bookings,
 * checkouts→contacts, maintenance→maintenance, warranty→warranty, expiry→perishables,
 * field-due→custom-fields), and every lane *also* gates on the read permission of what it draws
 * from (issue #522) — reorder, which has no module of its own, gates on `items:read` alone. A
 * gated-off lane passes `enabled: false` to its feed query and feeds an empty array into the
 * seam, so it produces no events even though the mocked feed still returns rows (a stale-cache
 * stand-in).
 *
 * `useQuery` is mocked and keyed off the query key so each of the seven feeds returns its own
 * rows and records the `enabled` flag it was called with; the modules store is the real store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: h.useQuery }));

// The lane-walking suite below drives the real `queryFn`s, so the repositories they reach for
// are stubbed. The gating suites never call a `queryFn`, so these stay unused there.
const repos = vi.hoisted(() => ({
  getAssetBookingRepository: vi.fn(),
  getCheckoutRepository: vi.fn(),
  getItemRepository: vi.fn(),
  getMaintenanceRepository: vi.fn(),
  getReportRepository: vi.fn(),
}));
vi.mock('@/db/repositories', () => repos);

import { useAgenda } from './useAgenda';
import type { AgendaKind } from './agenda';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = Date.now() - DAY_MS;

/** Per-lane feed data, keyed by the second query-key segment. */
const LANE_DATA: Record<string, unknown> = {
  maintenance: {
    rows: [
      {
        id: 'sch-1',
        itemId: 'it-1',
        itemName: 'Mower',
        name: 'Oil change',
        basis: 'TIME',
        lastPerformedAt: null,
        createdAt: PAST - DAY_MS,
        intervalDays: 1,
        intervalUsage: null,
        usageSinceService: null,
        accrueCheckoutHours: false,
        autoUsageHours: null,
      },
    ],
  },
  warranty: {
    rows: [{ id: 'it-2', name: 'Drill', warrantyExpiresAt: new Date(PAST).toISOString().slice(0, 10) }],
  },
  expiry: { rows: [{ id: 'it-3', name: 'Milk', expiryDate: PAST }] },
  checkouts: {
    rows: [{ id: 'ck-1', itemId: 'it-4', itemName: 'Camera', borrowerName: 'Alex', dueDate: PAST }],
  },
  reorder: [{ itemId: 'it-5', itemName: 'Screws', shortfall: 3 }],
  bookings: {
    rows: [
      {
        id: 'bk-1',
        itemId: 'it-6',
        itemName: 'Projector',
        contactName: 'Sam',
        startDate: PAST,
        endDate: PAST + DAY_MS,
      },
    ],
  },
  // The due-date lane reads through `readAllPages`, whose envelope is `{ rows, truncated }`.
  'field-due': {
    rows: [
      {
        itemId: 'it-7',
        itemName: 'Studio insurance',
        defId: 'def-1',
        fieldName: 'Renewal date',
        leadDays: 14,
        dueAt: Date.parse(new Date(PAST).toISOString().slice(0, 10)),
      },
    ],
    truncated: false,
  },
};

/** `enabled` flag captured per lane during the last render. */
let enabledByLane: Record<string, boolean | undefined> = {};

/** Put the session on a `granted` authority holding exactly `grants`. */
function grant(...grants: readonly string[]) {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(grants) } });
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
  enabledByLane = {};
  h.useQuery.mockImplementation((opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const lane = String(opts.queryKey[1]);
    enabledByLane[lane] = opts.enabled;
    return { data: LANE_DATA[lane], isLoading: false, isError: false };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

function kinds(): Set<AgendaKind> {
  const { result } = renderHook(() => useAgenda());
  return new Set(result.current.events.map((e) => e.kind));
}

describe('useAgenda — all features on (default)', () => {
  it('produces every lane and enables every feed', () => {
    const present = kinds();
    expect(present).toEqual(
      new Set<AgendaKind>([
        'maintenance',
        'warranty',
        'expiry',
        'checkout-due',
        'reorder',
        'booking',
        'field-due',
      ]),
    );
    expect(enabledByLane.maintenance).toBe(true);
    expect(enabledByLane.warranty).toBe(true);
    expect(enabledByLane.expiry).toBe(true);
    expect(enabledByLane.checkouts).toBe(true);
    expect(enabledByLane.bookings).toBe(true);
    expect(enabledByLane['field-due']).toBe(true);
    // Reorder has no module of its own, but it is item stock, so it follows `items:read`.
    expect(enabledByLane.reorder).toBe(true);
  });
});

describe('useAgenda — per-lane gating', () => {
  it('Maintenance off drops the maintenance lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('maintenance', false);
    const present = kinds();
    expect(present.has('maintenance')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane.maintenance).toBe(false);
  });

  it('Warranty off drops the warranty lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('warranty', false);
    const present = kinds();
    expect(present.has('warranty')).toBe(false);
    expect(enabledByLane.warranty).toBe(false);
  });

  it('Expiry tracking off drops the expiry lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    const present = kinds();
    expect(present.has('expiry')).toBe(false);
    expect(enabledByLane.expiry).toBe(false);
  });

  it('Contacts off drops the checkout lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    const present = kinds();
    expect(present.has('checkout-due')).toBe(false);
    expect(enabledByLane.checkouts).toBe(false);
  });

  it('Bookings off drops the booking lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('bookings', false);
    const present = kinds();
    expect(present.has('booking')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane.bookings).toBe(false);
  });

  it('Custom fields off drops the custom-field due-date lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('custom-fields', false);
    const present = kinds();
    expect(present.has('field-due')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane['field-due']).toBe(false);
  });
});

/**
 * Issue #522: a role that cannot open Bookings could still read its rows here, because Upcoming
 * aggregates several subjects and so carries no read gate of its own. The gate is per lane.
 */
describe('useAgenda — per-lane read permissions', () => {
  it('drops the booking lane for a role without bookings:read, and disables its feed', () => {
    grant('items:read', 'maintenance:read', 'checkouts:read');
    const present = kinds();
    expect(present.has('booking')).toBe(false);
    expect(enabledByLane.bookings).toBe(false);
    // The lanes the role *can* read are untouched.
    expect(present.has('maintenance')).toBe(true);
    expect(present.has('checkout-due')).toBe(true);
  });

  it('drops the maintenance lane for a role without maintenance:read', () => {
    grant('items:read', 'bookings:read', 'checkouts:read');
    const present = kinds();
    expect(present.has('maintenance')).toBe(false);
    expect(enabledByLane.maintenance).toBe(false);
  });

  it('drops every item-derived lane, reorder included, without items:read', () => {
    grant('bookings:read');
    const present = kinds();
    for (const kind of ['warranty', 'expiry', 'reorder', 'field-due'] as const) {
      expect(present.has(kind)).toBe(false);
    }
    expect(enabledByLane.reorder).toBe(false);
    // Bookings is not item data, so it survives.
    expect(present.has('booking')).toBe(true);
  });
});

describe('useAgenda — truncation is reported, not swallowed', () => {
  /** Re-mock `useQuery` so one lane claims its read-everything walk hit the ceiling. */
  function truncate(lane: string) {
    h.useQuery.mockImplementation((opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
      const key = String(opts.queryKey[1]);
      const data = key === lane ? { rows: [], truncated: true } : LANE_DATA[key];
      return { data, isLoading: false, isError: false };
    });
  }

  it("passes the read-everything walk's ceiling flag through to the screen", () => {
    truncate('field-due');
    const { result } = renderHook(() => useAgenda());
    expect(result.current.truncatedKinds).toEqual(new Set<AgendaKind>(['field-due']));
  });

  it('reports the lane that was capped, not a stand-in for it', () => {
    // Every paginated lane walks its pages now (issue #607), so each has its own ceiling to
    // report; naming the wrong one would send the reader to a complete lane.
    for (const [lane, kind] of [
      ['maintenance', 'maintenance'],
      ['warranty', 'warranty'],
      ['expiry', 'expiry'],
      ['checkouts', 'checkout-due'],
      ['bookings', 'booking'],
      ['field-due', 'field-due'],
    ] as const) {
      truncate(lane);
      const { result } = renderHook(() => useAgenda());
      expect(result.current.truncatedKinds).toEqual(new Set<AgendaKind>([kind]));
    }
  });

  it('never reports truncation for a lane whose module is off', () => {
    useModulesStore.getState().setFeatureIntent('custom-fields', false);
    // A stale cache entry from when the module was on, still claiming truncation.
    truncate('field-due');
    const { result } = renderHook(() => useAgenda());
    expect(result.current.truncatedKinds.size).toBe(0);
  });
});

/**
 * Issue #607: every paginated lane asked for a 500-row page, and every repository read clamps
 * `limit` to `MAX_PAGE_SIZE` (100) — so each lane got a fifth of what the hook believed it had,
 * and said nothing. Worse for the two dated item lanes, which order by date *ascending* under a
 * century-wide cutoff: the hundred rows they kept were the hundred longest-expired, so nothing
 * actually upcoming reached the screen at all.
 *
 * These drive the real `queryFn`s against a fake repository that honours the clamp, which is the
 * only way to see the difference — the mocked `useQuery` above never calls them.
 */
describe('useAgenda — every paginated lane reads past the page ceiling', () => {
  /** Rows returned by the fake feeds; comfortably past `MAX_PAGE_SIZE`. */
  const TOTAL = 250;

  /** Query fns captured from the last render, keyed by the second query-key segment. */
  let fnByLane: Record<string, (() => Promise<unknown>) | undefined> = {};
  /** Page params each fake feed was called with, in call order, keyed by lane. */
  let pagesByLane: Record<string, { limit: number; offset: number }[]> = {};
  /** The `since` bound each dated item feed was passed, keyed by lane. */
  let sinceByLane: Record<string, number | undefined> = {};

  /** A feed of `TOTAL` rows that clamps `limit` exactly as `BaseRepository.resolvePage` does. */
  function fakeFeed(lane: string) {
    return (params: { limit?: number; offset?: number; since?: number } = {}) => {
      const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(params.limit ?? 50)));
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      (pagesByLane[lane] ??= []).push({ limit, offset });
      if ('since' in params) sinceByLane[lane] = params.since;
      const rows = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => ({
        id: `${lane}-${offset + i}`,
        name: `Row ${offset + i}`,
      }));
      return Promise.resolve({ rows, limit, offset, hasMore: rows.length === limit });
    };
  }

  beforeEach(() => {
    fnByLane = {};
    pagesByLane = {};
    sinceByLane = {};
    h.useQuery.mockImplementation(
      (opts: { queryKey: readonly unknown[]; queryFn?: () => Promise<unknown> }) => {
        fnByLane[String(opts.queryKey[1])] = opts.queryFn;
        return { data: LANE_DATA[String(opts.queryKey[1])], isLoading: false, isError: false };
      },
    );
    repos.getMaintenanceRepository.mockReturnValue({
      listUpcoming: (_now: number, params: { limit?: number; offset?: number }) =>
        fakeFeed('maintenance')(params),
    });
    repos.getCheckoutRepository.mockReturnValue({ listOpen: fakeFeed('checkouts') });
    repos.getAssetBookingRepository.mockReturnValue({
      listUpcoming: (_now: number, params: { limit?: number; offset?: number }) =>
        fakeFeed('bookings')(params),
    });
    repos.getItemRepository.mockReturnValue({
      listWarrantyExpiring: (_days: number, _now: number, params: Record<string, number>) =>
        fakeFeed('warranty')(params),
      listExpiringWithin: (_days: number, _now: number, params: Record<string, number>) =>
        fakeFeed('expiry')(params),
      listFieldDueDates: (_now: number, params: Record<string, number>) => fakeFeed('field-due')(params),
    });
  });

  it.each(['maintenance', 'warranty', 'expiry', 'checkouts', 'bookings', 'field-due'])(
    'walks the %s lane past one page',
    async (lane) => {
      renderHook(() => useAgenda());
      const rows = (await fnByLane[lane]!()) as { rows: readonly unknown[]; truncated: boolean };
      expect(rows.rows).toHaveLength(TOTAL);
      expect(rows.truncated).toBe(false);
      // Every request is inside the ceiling, and the walk advances rather than re-reading page 0.
      expect(pagesByLane[lane]!.length).toBeGreaterThan(1);
      expect(pagesByLane[lane]!.every((p) => p.limit <= MAX_PAGE_SIZE)).toBe(true);
      expect(pagesByLane[lane]!.map((p) => p.offset)).toEqual([0, 100, 200]);
    },
  );

  it.each(['warranty', 'expiry'])('bounds how far back the %s lane reaches', async (lane) => {
    // Without a lower bound the century-wide cutoff selects every dated row ever, oldest
    // first — which is the shape that hid the near future behind decade-old history.
    renderHook(() => useAgenda());
    await fnByLane[lane]!();
    const since = sinceByLane[lane];
    expect(since).toBeDefined();
    const daysBack = Math.round((Date.now() - since!) / DAY_MS);
    expect(daysBack).toBe(365);
  });

  it('leaves the other lanes unbounded in the past', async () => {
    // A schedule stays due until performed and a loan stays open until returned, so trimming
    // their history would drop live work, not settled history.
    renderHook(() => useAgenda());
    for (const lane of ['maintenance', 'checkouts', 'bookings']) await fnByLane[lane]!();
    expect(sinceByLane.maintenance).toBeUndefined();
    expect(sinceByLane.checkouts).toBeUndefined();
    expect(sinceByLane.bookings).toBeUndefined();
  });
});
