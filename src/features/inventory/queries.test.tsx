/**
 * Query-gating for `useApplicableStatuses` (inventory filter perf P3).
 *
 * The applicable-statuses probe is a per-location `EXISTS` round-trip that populates the filter
 * bar's chip set. While the Visual Builder drives the results those chips are superseded and
 * disabled, so the hook is gated off (`active = !astActive`) — running the probe then couldn't
 * change anything the user can do, so it would be wasted work. These tests pin that gate: the
 * `active` argument is forwarded straight onto React Query's `enabled`, while the flicker-free
 * `placeholderData` stays in place regardless.
 *
 * Strategy: spy on `useQuery` at the module boundary (keeping the real `keepPreviousData`
 * sentinel) and read back the options the hook passes. `useApplicableStatuses` itself uses real
 * `useMemo` / store hooks, so it is driven through `renderHook`; only the query layer is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { keepPreviousData } from '@tanstack/react-query';

// Capture the options object the hook hands to useQuery (recorded via mock.calls; the
// implementation ignores its argument and returns an inert query result — the queryFn, and
// hence the repository, is never invoked).
/**
 * What each half's query resolves to, keyed by the distinguishing key segment. Default
 * (`undefined`) reproduces the original "nothing loaded yet" behaviour the gate tests assume;
 * the merge tests below set it per case.
 */
const resolved: Record<string, unknown> = {};

const useQuerySpy = vi.fn((options?: unknown) => {
  const key = (options as { queryKey?: readonly unknown[] } | undefined)?.queryKey;
  const half = key?.[2] as string | undefined;
  return { data: half ? resolved[half] : undefined };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: unknown) => useQuerySpy(options) };
});

import { ITEM_STATUS_FILTERS } from '@/db/repositories';
import { useApplicableStatuses } from './queries';

type QueryOptions = {
  enabled?: boolean;
  placeholderData?: unknown;
  queryKey?: readonly unknown[];
};

/** Every options object handed to useQuery during the last render. */
function allOptions(): QueryOptions[] {
  return useQuerySpy.mock.calls.map((call) => (call[0] ?? {}) as QueryOptions);
}

beforeEach(() => {
  useQuerySpy.mockClear();
  for (const key of Object.keys(resolved)) delete resolved[key];
});

/** Seed one half's resolved data (`'applicable-statuses'` = stock, `'stable-statuses'` = stable). */
function resolve(half: 'applicable-statuses' | 'stable-statuses', rows: { status: string; count: number }[]) {
  resolved[half] = rows;
}

describe('useApplicableStatuses — Visual Builder gate (P3)', () => {
  // The hook issues two queries (see the #166 split below); the gate applies to both, so each
  // assertion covers every probe rather than whichever happened to be called last.
  it('enables the probe by default (no active flag)', () => {
    renderHook(() => useApplicableStatuses('loc-1'));
    expect(allOptions().map((o) => o.enabled)).toEqual([true, true]);
  });

  it('enables the probe when active (the Visual Builder is not driving results)', () => {
    renderHook(() => useApplicableStatuses('loc-1', true));
    expect(allOptions().map((o) => o.enabled)).toEqual([true, true]);
  });

  it('gates the probe off while the Visual Builder supersedes the (disabled) chips', () => {
    renderHook(() => useApplicableStatuses('loc-1', false));
    expect(allOptions().map((o) => o.enabled)).toEqual([false, false]);
  });

  it('keeps the previous set on screen (placeholderData) regardless of the gate', () => {
    renderHook(() => useApplicableStatuses('loc-1', false));
    // Gating the query off must not drop the flicker-free behaviour: the last-known applicable
    // set stays put while the builder is active (harmless — the chips are disabled).
    for (const options of allOptions()) expect(options.placeholderData).toBe(keepPreviousData);
  });
});

/**
 * The counts are split across two caches so a stock-only write can invalidate the cheap half
 * without recomputing the expensive one (issue #166). What makes that work is the *keys*: the
 * stock-derived counts must sit under the `items()` prefix every item mutation sweeps, and the
 * rest under the sibling `item-attention` prefix that `invalidateItemStock` deliberately skips.
 * If those prefixes ever converged the split would silently stop saving anything.
 */
describe('useApplicableStatuses — stock/stable split (#166)', () => {
  it('probes the two halves under separate cache prefixes', () => {
    renderHook(() => useApplicableStatuses('loc-1'));
    const keys = allOptions().map((o) => o.queryKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]?.slice(0, 3)).toEqual(['inventory', 'items', 'applicable-statuses']);
    expect(keys[1]?.slice(0, 3)).toEqual(['inventory', 'item-attention', 'stable-statuses']);
  });

  it('splits the candidates so neither half probes the other half’s statuses', () => {
    renderHook(() => useApplicableStatuses('loc-1'));
    const [stock, stable] = allOptions().map(
      (o) => (o.queryKey?.at(-1) as { candidates: readonly string[] }).candidates,
    );
    expect(stock).toEqual(['low-stock', 'out-of-stock']);
    // The costly six — each carries a correlated per-row subquery.
    expect(stable).toEqual(['on-order', 'expiring', 'warranty', 'on-loan', 'overdue', 'maintenance-due']);
    // Between them they still cover everything a single un-split query would have probed.
    expect([...stock, ...stable].sort()).toEqual([...ITEM_STATUS_FILTERS].sort());
  });
});

/**
 * Splitting the query means the two halves now settle — and refetch — independently, so the
 * merge has to put them back together as if they never were split. The risk the split
 * introduces is a *partial* result: a stepper tap refetches only the stock half, and if the
 * merge published that half alone the six stable chips would vanish from the filter bar and
 * reappear a moment later. These tests pin the merge against that.
 */
describe('useApplicableStatuses — merging the halves (#166)', () => {
  it('returns the union of both halves in canonical order', () => {
    resolve('applicable-statuses', [{ status: 'out-of-stock', count: 3 }]);
    resolve('stable-statuses', [
      { status: 'maintenance-due', count: 1 },
      { status: 'expiring', count: 7 },
    ]);
    const { result } = renderHook(() => useApplicableStatuses('loc-1'));
    // Canonical ITEM_STATUS_FILTERS order, not the order the halves supplied them in.
    expect(result.current.data).toEqual([
      { status: 'out-of-stock', count: 3 },
      { status: 'expiring', count: 7 },
      { status: 'maintenance-due', count: 1 },
    ]);
  });

  it('holds back the merged set until BOTH halves are known', () => {
    // The stock half has refetched after a stepper tap; the stable half has not resolved yet.
    // Publishing now would drop every stable chip off the bar for a frame.
    resolve('applicable-statuses', [{ status: 'low-stock', count: 2 }]);
    const { result } = renderHook(() => useApplicableStatuses('loc-1'));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the stable half on screen while only the stock half changes', () => {
    resolve('applicable-statuses', [{ status: 'out-of-stock', count: 1 }]);
    resolve('stable-statuses', [{ status: 'overdue', count: 4 }]);
    const first = renderHook(() => useApplicableStatuses('loc-1'));
    expect(first.result.current.data).toEqual([
      { status: 'out-of-stock', count: 1 },
      { status: 'overdue', count: 4 },
    ]);

    // A stepper tap invalidates only the stock half — the stable half's cached rows are reused.
    resolve('applicable-statuses', []);
    const second = renderHook(() => useApplicableStatuses('loc-1'));
    expect(second.result.current.data).toEqual([{ status: 'overdue', count: 4 }]);
  });
});
