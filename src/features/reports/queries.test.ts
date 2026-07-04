/**
 * Flicker-free wiring for the window-toggle-driven Reports queries (inventory UX follow-up).
 *
 * Toggling the analytics / spend window re-keys these `useQuery` calls, so without
 * `placeholderData: keepPreviousData` the panel drops to its spinner for a frame before the
 * next window's data arrives. These tests pin the `keepPreviousData` option onto exactly the
 * hooks a window toggle re-keys — and assert the fixed-window reports deliberately do NOT set
 * it (the fix is targeted, not blanket-applied).
 *
 * Strategy: spy on `useQuery` at the module boundary (keeping `keepPreviousData` real) and read
 * back the options each hook passes. No React render, worker or repository is involved — the
 * repository accessor and preferences store are stubbed so calling a hook directly is inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keepPreviousData } from '@tanstack/react-query';

// Capture the options object each hook hands to useQuery (recorded via mock.calls; the
// implementation ignores its argument and returns an inert query result).
const useQuerySpy = vi.fn(() => ({ data: undefined, isLoading: false }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: unknown) => useQuerySpy(options) };
});

// The queryFn is never invoked here (useQuery is stubbed), so an empty repository is enough.
vi.mock('@/db/repositories', () => ({
  getReportRepository: () => ({}),
}));

// useLowStockCount reads the preferences store; return static thresholds so it doesn't throw.
vi.mock('@/state/stores/usePreferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ lowStockQtyThreshold: 1, lowStockGaugePercent: 10 }),
}));

import {
  useConsumptionRate,
  useDeadStock,
  useMovement,
  useSpendAnalytics,
  useTurnover,
  useValuationTrend,
} from './queries';

/** The `placeholderData` option from the most recent useQuery call. */
function lastPlaceholderData(): unknown {
  const call = useQuerySpy.mock.calls.at(-1);
  return (call?.[0] as { placeholderData?: unknown } | undefined)?.placeholderData;
}

beforeEach(() => {
  useQuerySpy.mockClear();
});

describe('Reports queries — flicker-free window toggles', () => {
  it('useTurnover keeps the previous window while a new one loads', () => {
    useTurnover(90);
    expect(lastPlaceholderData()).toBe(keepPreviousData);
  });

  it('useValuationTrend keeps the previous window while a new one loads', () => {
    useValuationTrend(90);
    expect(lastPlaceholderData()).toBe(keepPreviousData);
  });

  it('useSpendAnalytics keeps the previous window while a new one loads', () => {
    useSpendAnalytics(90);
    expect(lastPlaceholderData()).toBe(keepPreviousData);
  });

  it('still passes the spend query enabled flag alongside placeholderData', () => {
    useSpendAnalytics(90, { enabled: false });
    const opts = useQuerySpy.mock.calls.at(-1)?.[0] as {
      enabled?: boolean;
      placeholderData?: unknown;
    };
    expect(opts.enabled).toBe(false);
    expect(opts.placeholderData).toBe(keepPreviousData);
  });
});

describe('Reports queries — fixed-window reports are left untouched', () => {
  // These reports have no on-screen filter toggle re-keying them, so keepPreviousData would be
  // dead weight. Pinning their absence stops a future blanket-apply from creeping in.
  it('useConsumptionRate does not set placeholderData', () => {
    useConsumptionRate();
    expect(lastPlaceholderData()).toBeUndefined();
  });

  it('useMovement does not set placeholderData', () => {
    useMovement();
    expect(lastPlaceholderData()).toBeUndefined();
  });

  it('useDeadStock does not set placeholderData', () => {
    useDeadStock();
    expect(lastPlaceholderData()).toBeUndefined();
  });
});
