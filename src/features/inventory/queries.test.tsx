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
const useQuerySpy = vi.fn(() => ({ data: undefined }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: unknown) => useQuerySpy(options) };
});

import { useApplicableStatuses } from './queries';

/** The options object from the most recent useQuery call. */
function lastOptions(): { enabled?: boolean; placeholderData?: unknown } {
  return (useQuerySpy.mock.calls.at(-1)?.[0] ?? {}) as {
    enabled?: boolean;
    placeholderData?: unknown;
  };
}

beforeEach(() => {
  useQuerySpy.mockClear();
});

describe('useApplicableStatuses — Visual Builder gate (P3)', () => {
  it('enables the probe by default (no active flag)', () => {
    renderHook(() => useApplicableStatuses('loc-1'));
    expect(lastOptions().enabled).toBe(true);
  });

  it('enables the probe when active (the Visual Builder is not driving results)', () => {
    renderHook(() => useApplicableStatuses('loc-1', true));
    expect(lastOptions().enabled).toBe(true);
  });

  it('gates the probe off while the Visual Builder supersedes the (disabled) chips', () => {
    renderHook(() => useApplicableStatuses('loc-1', false));
    expect(lastOptions().enabled).toBe(false);
  });

  it('keeps the previous set on screen (placeholderData) regardless of the gate', () => {
    renderHook(() => useApplicableStatuses('loc-1', false));
    // Gating the query off must not drop the flicker-free behaviour: the last-known applicable
    // set stays put while the builder is active (harmless — the chips are disabled).
    expect(lastOptions().placeholderData).toBe(keepPreviousData);
  });
});
