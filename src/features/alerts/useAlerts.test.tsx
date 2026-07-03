/**
 * Hook-wiring tests for `useAlerts` feature gating (Modular UI Phase 7).
 *
 * The pure `buildAlerts` seam is exhaustively covered in `alerts.test.ts`; here we verify the
 * hook's deep-cascade wiring: when the Expiry-tracking, Maintenance or Warranty feature is off,
 * the hook (a) passes `enabled: false` to that lane's source query — skipping the fetch — and
 * (b) feeds an empty array into the seam, so the lane produces no alerts even though the mocked
 * source still returns rows (simulating a stale cache from when the feature was on). Low stock is
 * core inventory and is never gated.
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
  useQuery: vi.fn(),
}));

vi.mock('@/features/lifecycle', () => ({
  useLowStockItems: h.useLowStockItems,
  useExpiringItems: h.useExpiringItems,
  useDueMaintenance: h.useDueMaintenance,
}));

// The warranty lane is a bespoke `useQuery` inside the hook; mock it so no query client or
// repository is needed and we can capture the `enabled` flag it was called with.
vi.mock('@tanstack/react-query', () => ({ useQuery: h.useQuery }));

import { useAlerts } from './useAlerts';
import type { AlertKind } from './alerts';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_AT = Date.now() - DAY_MS; // an expired perishable → emits an alert
const WARRANTY_EXPIRED_ISO = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);

function loaded<T>(rows: T[]) {
  return { data: { rows }, isLoading: false, isError: false };
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useDismissedAlertsStore.setState({ dismissedIds: new Set() });

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
  h.useQuery.mockReturnValue(
    loaded([
      {
        id: 'war-1',
        name: 'Drill',
        acquiredAt: null,
        warrantyExpiresAt: WARRANTY_EXPIRED_ISO,
        purchasePrice: null,
        depreciationMonths: null,
      },
    ]),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  useModulesStore.setState({ intent: {} });
});

/** Kinds present in the hook's produced alerts. */
function kinds(): Set<AlertKind> {
  const { result } = renderHook(() => useAlerts());
  return new Set(result.current.allAlerts.map((a) => a.kind));
}

/** The `enabled` flag the bespoke warranty `useQuery` was last called with. */
function warrantyEnabled(): boolean | undefined {
  const lastCall = h.useQuery.mock.calls.at(-1)?.[0] as { enabled?: boolean } | undefined;
  return lastCall?.enabled;
}

describe('useAlerts — all features on (default)', () => {
  it('produces every lane and enables every source query', () => {
    const present = kinds();
    expect(present).toEqual(new Set<AlertKind>(['low-stock', 'expiry', 'maintenance-due', 'warranty-due']));
    expect(h.useExpiringItems).toHaveBeenCalledWith(expect.anything(), { enabled: true });
    expect(h.useDueMaintenance).toHaveBeenCalledWith({ enabled: true });
    expect(warrantyEnabled()).toBe(true);
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
    expect(warrantyEnabled()).toBe(false);
  });
});
