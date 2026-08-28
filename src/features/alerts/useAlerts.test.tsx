/**
 * Hook-wiring tests for `useAlerts` feature gating (Modular UI Phase 7).
 *
 * The pure `buildAlerts` seam is exhaustively covered in `alerts.test.ts`; here we verify the
 * hook's deep-cascade wiring: when the Expiry-tracking, Maintenance, Warranty or Custom-fields
 * feature is off,
 * the hook (a) passes `enabled: false` to that lane's source query — skipping the fetch — and
 * (b) feeds an empty array into the seam, so the lane produces no alerts even though the mocked
 * source still returns rows (simulating a stale cache from when the feature was on). Every lane
 * *also* gates on the read permission of what it draws from (issue #522) — low stock, which has
 * no module of its own, gates on `items:read` alone.
 *
 * The source hooks and TanStack Query's `useQuery` are mocked so the hook never touches the
 * SQLite worker; the modules store is the real Zustand store, driven per-test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Hoisted spies shared with the module mocks below.
const h = vi.hoisted(() => ({
  useLowStockItems: vi.fn(),
  useExpiringItems: vi.fn(),
  useDueMaintenance: vi.fn(),
  useExpiringCount: vi.fn(),
  useDueMaintenanceCount: vi.fn(),
  useLowStockCount: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock('@/features/lifecycle/hooks', () => ({
  useLowStockItems: h.useLowStockItems,
  useExpiringItems: h.useExpiringItems,
  useDueMaintenance: h.useDueMaintenance,
  useExpiringCount: h.useExpiringCount,
  useDueMaintenanceCount: h.useDueMaintenanceCount,
}));

// The low-stock total is the report repository's existing `COUNT(*)` (issue #606), so it comes
// from the reports read seam rather than the lifecycle hooks above.
vi.mock('@/features/reports/queries', () => ({ useLowStockCount: h.useLowStockCount }));

// The warranty and custom-field-due lanes are bespoke `useQuery` calls inside the hook; mock it
// so no query client or repository is needed and we can capture the `enabled` flag each was
// called with. Both go through this one spy, so the fixtures below dispatch on the query key.
vi.mock('@tanstack/react-query', () => ({ useQuery: h.useQuery }));

import { useAlerts } from './useAlerts';
import type { AlertKind } from './alerts';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_AT = Date.now() - DAY_MS; // an expired perishable → emits an alert
const WARRANTY_EXPIRED_ISO = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
// A custom DATE field whose day has passed → its definition's opt-in makes it an alert.
const FIELD_DUE_AT = Date.parse(new Date(Date.now() - DAY_MS).toISOString().slice(0, 10));

function loaded<T>(rows: T[]) {
  return { data: { rows }, isLoading: false, isError: false };
}

const WARRANTY_ROWS = [
  {
    id: 'war-1',
    name: 'Drill',
    acquiredAt: null,
    warrantyExpiresAt: WARRANTY_EXPIRED_ISO,
    purchasePrice: null,
    depreciationMonths: null,
  },
];

const FIELD_DUE_ROWS = [
  {
    itemId: 'it-9',
    itemName: 'Studio insurance',
    defId: 'def-9',
    fieldName: 'Renewal date',
    leadDays: 14,
    dueAt: FIELD_DUE_AT,
  },
];

/** Which bespoke lane a `useQuery` call belongs to, read from its key's second segment. */
function laneOf(options: { queryKey?: readonly unknown[] } | undefined): string {
  return String(options?.queryKey?.[1] ?? '');
}

/**
 * Is this `useQuery` call the lane's **feed**, rather than the `COUNT(*)` beside it (issue #606)?
 * Both sit under the same key prefix, so without this the count's `enabled` — which is also
 * gated on the caller asking for totals — would be read as the feed's and every gating
 * assertion below would be answering about the wrong query.
 */
function isFeed(options: { queryKey?: readonly unknown[] } | undefined): boolean {
  return options?.queryKey?.at(-1) !== 'count';
}

/** Put the session on a `granted` authority holding exactly `grants`. */
function grant(...grants: readonly string[]) {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(grants) } });
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
  useDismissedAlertsStore.setState({ dismissals: new Map() });

  // Every source returns rows regardless of `enabled`, so a gated-off lane that still produces
  // an alert would prove the gating is broken.
  h.useLowStockItems.mockReturnValue(loaded([{ id: 'low-1', name: 'Low widget' }]));
  h.useExpiringItems.mockReturnValue(loaded([{ id: 'exp-1', name: 'Milk', expiryDate: EXPIRED_AT }]));
  h.useDueMaintenance.mockReturnValue(
    loaded([
      {
        id: 'sch-1',
        name: 'Oil change',
        itemId: 'it-1',
        itemName: 'Mower',
        basis: 'TIME',
        lastPerformedAt: null,
        createdAt: EXPIRED_AT - DAY_MS,
        intervalDays: 1,
      },
    ]),
  );
  // Both bespoke lanes share one spy, so answer by key rather than returning warranty rows to
  // the due-date lane (which would silently grade to "nothing due" and hide a broken gate).
  h.useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
    if (!isFeed(options)) return { data: undefined, isLoading: false, isError: false };
    return laneOf(options) === 'field-due-dates'
      ? { data: { rows: FIELD_DUE_ROWS, truncated: false }, isLoading: false, isError: false }
      : loaded(WARRANTY_ROWS);
  });
  // The three hook-shaped totals are only read by a caller that asks for them; the lanes under
  // test do not, so they answer "not fetched" and never contribute to a lane's alerts.
  for (const total of [h.useExpiringCount, h.useDueMaintenanceCount, h.useLowStockCount]) {
    total.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  }
});

afterEach(() => {
  vi.clearAllMocks();
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

/** Kinds present in the hook's produced alerts. */
function kinds(): Set<AlertKind> {
  const { result } = renderHook(() => useAlerts());
  return new Set(result.current.allAlerts.map((a) => a.kind));
}

/** The `enabled` flag a bespoke lane's `useQuery` was last called with. */
function laneEnabled(lane: 'warranty-expiring' | 'field-due-dates'): boolean | undefined {
  const calls = h.useQuery.mock.calls as [{ queryKey?: readonly unknown[]; enabled?: boolean }][];
  return calls.filter(([o]) => laneOf(o) === lane && isFeed(o)).at(-1)?.[0]?.enabled;
}

/**
 * Issue #522: Alerts aggregates several subjects and so carries no read gate of its own. A role
 * that cannot open Maintenance could still read its due schedules here until each lane gated on
 * the permission of what it draws from.
 */
describe('useAlerts — per-lane read permissions', () => {
  it('drops the maintenance lane for a role without maintenance:read, and skips its fetch', () => {
    grant('items:read');
    const present = kinds();
    expect(present.has('maintenance-due')).toBe(false);
    expect(h.useDueMaintenance).toHaveBeenCalledWith({ enabled: false });
    // Everything drawn from items is untouched.
    expect(present.has('low-stock')).toBe(true);
    expect(present.has('expiry')).toBe(true);
  });

  it('drops every item-derived lane, low stock included, without items:read', () => {
    grant('maintenance:read');
    const present = kinds();
    for (const kind of ['low-stock', 'expiry', 'warranty-due', 'field-due'] as const) {
      expect(present.has(kind)).toBe(false);
    }
    expect(h.useLowStockItems).toHaveBeenCalledWith(expect.anything(), { enabled: false });
    expect(laneEnabled('warranty-expiring')).toBe(false);
    expect(present.has('maintenance-due')).toBe(true);
  });
});

describe('useAlerts — all features on (default)', () => {
  it('produces every lane and enables every source query', () => {
    const present = kinds();
    expect(present).toEqual(
      new Set<AlertKind>(['low-stock', 'expiry', 'maintenance-due', 'warranty-due', 'field-due']),
    );
    expect(h.useLowStockItems).toHaveBeenCalledWith(expect.anything(), { enabled: true });
    expect(h.useExpiringItems).toHaveBeenCalledWith(expect.anything(), { enabled: true });
    expect(h.useDueMaintenance).toHaveBeenCalledWith({ enabled: true });
    expect(laneEnabled('warranty-expiring')).toBe(true);
    expect(laneEnabled('field-due-dates')).toBe(true);
  });

  it('raises an expiry alert for an item dated only on its lots (issue #684)', () => {
    // The feed selects such a row on its *effective* expiry, so the projection has to hand the
    // alert builder that date too — reading `expiryDate` alone drops exactly the rows the
    // repository went to the trouble of finding.
    h.useExpiringItems.mockReturnValue(
      loaded([{ id: 'exp-2', name: 'Culture', expiryDate: null, earliestBatchExpiryDate: EXPIRED_AT }]),
    );
    expect(kinds().has('expiry')).toBe(true);
  });
});

describe('useAlerts — Custom fields off', () => {
  it('drops the custom-field due-date lane and disables its query', () => {
    useModulesStore.getState().setFeatureIntent('custom-fields', false);
    const present = kinds();
    expect(present.has('field-due')).toBe(false);
    expect(present.has('expiry')).toBe(true);
    expect(laneEnabled('field-due-dates')).toBe(false);
  });
});

describe('useAlerts — Expiry tracking off', () => {
  it('drops the expiry lane and disables its query, leaving the others', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    const present = kinds();
    expect(present.has('expiry')).toBe(false);
    expect(present.has('low-stock')).toBe(true);
    expect(present.has('maintenance-due')).toBe(true);
    expect(present.has('warranty-due')).toBe(true);
    expect(h.useExpiringItems).toHaveBeenCalledWith(expect.anything(), { enabled: false });
  });
});

describe('useAlerts — Maintenance off', () => {
  it('drops the maintenance lane and disables its query', () => {
    useModulesStore.getState().setFeatureIntent('maintenance', false);
    const present = kinds();
    expect(present.has('maintenance-due')).toBe(false);
    expect(present.has('expiry')).toBe(true);
    expect(h.useDueMaintenance).toHaveBeenCalledWith({ enabled: false });
  });
});

describe('useAlerts — Warranty off', () => {
  it('drops the warranty lane and disables its query', () => {
    useModulesStore.getState().setFeatureIntent('warranty', false);
    const present = kinds();
    expect(present.has('warranty-due')).toBe(false);
    expect(present.has('expiry')).toBe(true);
    expect(laneEnabled('warranty-expiring')).toBe(false);
  });
});

/**
 * Dismissal housekeeping (issue #134). `pruneDismissals` itself is covered exhaustively in
 * `alerts.test.ts`; what matters here is the wiring — that the hook actually reconciles the
 * store against the live feed, and that it holds off while the feed can't be trusted.
 */
describe('useAlerts — dismissal pruning', () => {
  const LONG_AGO = Date.now() - 60 * DAY_MS;

  it('drops a record whose alert stopped firing, keeping the live one', () => {
    useDismissedAlertsStore.setState({
      dismissals: new Map([
        ['low-stock:low-1', { until: null, at: LONG_AGO }],
        ['low-stock:deleted-item', { until: null, at: LONG_AGO }],
      ]),
    });

    renderHook(() => useAlerts());

    expect([...useDismissedAlertsStore.getState().dismissals.keys()]).toEqual(['low-stock:low-1']);
  });

  it('leaves the records alone while a source is still loading', () => {
    // Every feed reads empty mid-load, so pruning then would discard the lot.
    h.useLowStockItems.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    useDismissedAlertsStore.setState({
      dismissals: new Map([['low-stock:deleted-item', { until: null, at: LONG_AGO }]]),
    });

    renderHook(() => useAlerts());

    expect(useDismissedAlertsStore.getState().dismissals.size).toBe(1);
  });

  it('retires a record as soon as its lane is read whole without it (issue #644)', () => {
    // A complete feed — `hasMore: false` — that no longer names the item is proof the shortage
    // is over, so the dismissal goes now rather than in a month's time. Restock a dismissed item
    // and run it down again next week and the alert must come back.
    h.useLowStockItems.mockReturnValue({
      data: { rows: [{ id: 'low-1', name: 'Low widget' }], hasMore: false },
      isLoading: false,
      isError: false,
    });
    useDismissedAlertsStore.setState({
      dismissals: new Map([['low-stock:restocked', { until: null, at: Date.now() - DAY_MS }]]),
    });

    renderHook(() => useAlerts());

    expect(useDismissedAlertsStore.getState().dismissals.size).toBe(0);
  });

  it('keeps that record when the lane stopped at its page ceiling', () => {
    // `hasMore: true` — the item may simply be past the ceiling, so absence proves nothing and
    // only the staleness rule may drop it.
    h.useLowStockItems.mockReturnValue({
      data: { rows: [{ id: 'low-1', name: 'Low widget' }], hasMore: true },
      isLoading: false,
      isError: false,
    });
    useDismissedAlertsStore.setState({
      dismissals: new Map([['low-stock:maybe-gone', { until: null, at: Date.now() - DAY_MS }]]),
    });

    renderHook(() => useAlerts());

    expect(useDismissedAlertsStore.getState().dismissals.size).toBe(1);
  });

  it('does not judge a lane whose module is off, however complete its cached feed reads', () => {
    // Perishables off: the hook feeds the seam an empty lane, which must not read as "every
    // expiry alert resolved" and wipe those dismissals.
    useModulesStore.getState().setFeatureIntent('perishables', false);
    h.useExpiringItems.mockReturnValue({
      data: { rows: [], hasMore: false },
      isLoading: false,
      isError: false,
    });
    useDismissedAlertsStore.setState({
      dismissals: new Map([['expiry:exp-1:2026-01-01:expired', { until: null, at: Date.now() - DAY_MS }]]),
    });

    renderHook(() => useAlerts());

    expect(useDismissedAlertsStore.getState().dismissals.size).toBe(1);
  });

  it('hides a snoozed alert from the feed but not from the total', () => {
    useDismissedAlertsStore.setState({
      dismissals: new Map([['low-stock:low-1', { until: Date.now() + DAY_MS, at: Date.now() }]]),
    });

    const { result } = renderHook(() => useAlerts());

    expect(result.current.alerts.some((a) => a.id === 'low-stock:low-1')).toBe(false);
    expect(result.current.allAlerts.some((a) => a.id === 'low-stock:low-1')).toBe(true);
  });
});
