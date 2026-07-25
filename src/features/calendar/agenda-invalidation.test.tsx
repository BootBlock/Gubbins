/**
 * The write ⇄ agenda invalidation invariant (issue #374).
 *
 * The "Upcoming" agenda's six lanes are reads over rows the rest of the app writes constantly —
 * item dates and stock, maintenance schedules, open loans, outstanding purchase orders, bookings.
 * The `['agenda']` prefix used to be swept by booking writes alone, so editing an expiry date,
 * logging maintenance, checking an item back in or ordering stock left five of the six lanes
 * showing pre-write data until the route was remounted — and the client sets
 * `refetchOnWindowFocus: false`, so nothing else recovered it.
 *
 * These tests pin both halves of the fix: that every write seam which can reshape a lane really
 * does sweep the prefix, and that every lane is genuinely *under* that prefix — a lane keyed by a
 * re-typed literal would drift straight back out of the sweep, which is how this happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { repoPath, sourceFiles } from '@/test/repo-path';
import { invalidateItems, invalidateItemStock } from '@/features/inventory/invalidate';
import { agendaKeys } from './keys';

// The write seams under test reach the database through the repository barrel; each mutation is
// stubbed to resolve so the hook's `onSuccess`/`onSettled` — the invalidation being asserted —
// actually runs. `importOriginal` keeps the barrel's constants and types intact for the modules
// that pull them in alongside the getters.
const repos = vi.hoisted(() => ({
  logPerformed: vi.fn(async () => undefined),
  setStatus: vi.fn(async () => undefined),
  createBooking: vi.fn(async () => ({ id: 'bk-1' })),
}));

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMaintenanceRepository: () => ({ logPerformed: repos.logPerformed }),
  getPurchaseOrderRepository: () => ({ setStatus: repos.setStatus }),
  getAssetBookingRepository: () => ({ create: repos.createBooking }),
}));

import { useLogMaintenance } from '@/features/lifecycle/hooks';
import { useSetPurchaseOrderStatus } from '@/features/purchasing/queries';
import { useCreateBooking } from '@/features/bookings/bookings';

/** A real `QueryClient` with `invalidateQueries` recorded rather than executed. */
function recordingClient() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
  const keys: unknown[][] = [];
  client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    keys.push(filters?.queryKey ?? []);
    return Promise.resolve();
  }) as QueryClient['invalidateQueries'];
  return { client, keys };
}

/** …the same client, wrapped so a mutation hook can be rendered against it. */
function trackedClient() {
  const { client, keys } = recordingClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { keys, wrapper };
}

/** Did any recorded invalidation cover the agenda prefix? */
function sweptAgenda(keys: unknown[][]): boolean {
  return keys.some((key) => Array.isArray(key) && key.length === 1 && key[0] === agendaKeys.all[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the shared item invalidation seam', () => {
  it('sweeps the agenda alongside the item and report prefixes', () => {
    const { client, keys } = recordingClient();
    invalidateItems(client);
    expect(sweptAgenda(keys)).toBe(true);
  });

  it('keeps the agenda in the narrow stock-only sweep too', () => {
    // The reorder-now lane is on-hand quantity against the reorder point, which is exactly what a
    // stepper tap or gauge adjust moves — so the narrow helper cannot drop this prefix the way it
    // drops `item-attention`.
    const { client, keys } = recordingClient();
    invalidateItemStock(client);
    expect(sweptAgenda(keys)).toBe(true);
  });
});

describe('write seams outside the item helpers', () => {
  it('logging maintenance sweeps the agenda (maintenance lane)', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useLogMaintenance(), { wrapper });

    result.current.mutate({ id: 'sch-1', itemId: 'it-1', note: 'Oiled' });

    await waitFor(() => expect(repos.logPerformed).toHaveBeenCalled());
    await waitFor(() => expect(sweptAgenda(keys)).toBe(true));
  });

  it('a purchase-order status change sweeps the agenda (reorder lane)', async () => {
    // The reorder lane nets stock already on order off the shortfall it reports, so ordering or
    // cancelling a PO restates how far below the reorder point an item is without any item row
    // moving — and the lane kept showing the pre-order figure.
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useSetPurchaseOrderStatus(), { wrapper });

    result.current.mutate({ id: 'po-1', status: 'ORDERED' });

    await waitFor(() => expect(repos.setStatus).toHaveBeenCalled());
    await waitFor(() => expect(sweptAgenda(keys)).toBe(true));
  });

  it('creating a booking still sweeps the agenda (bookings lane)', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useCreateBooking(), { wrapper });

    result.current.mutate({ itemId: 'it-1', contactId: 'ct-1', startDate: 1, endDate: 2 });

    await waitFor(() => expect(repos.createBooking).toHaveBeenCalled());
    await waitFor(() => expect(sweptAgenda(keys)).toBe(true));
  });
});

describe('the agenda prefix', () => {
  const SRC = repoPath(import.meta.dirname, 'src');

  it('is the prefix every lane query key is built from', () => {
    const hook = readFileSync(join(SRC, 'features', 'calendar', 'useAgenda.ts'), 'utf8');
    const keys = [...hook.matchAll(/queryKey: (.+),$/gm)].map((m) => m[1]);

    // Every `useQuery` must have contributed a key, or a lane has taken a shape this sweep can't
    // see — which would let it drift off the prefix unnoticed, exactly as the bare literals did.
    expect(keys).toHaveLength(hook.split('useQuery({').length - 1);
    for (const key of keys) expect(key?.startsWith('agendaKeys.')).toBe(true);
  });

  it('is never re-typed as a bare literal outside the key module', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('features', 'calendar', 'keys.ts')))
      .filter((path) => /\[\s*'agenda'/.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('rides along with every on-order sweep, which no call site performs alone', () => {
    // The reorder lane's shortfall figure nets off what is already on order, so the two prefixes
    // have to move together. `invalidateOnOrder` is the only place that says so; a call site
    // reaching for the raw prefix would refresh the outstanding totals and leave the lane behind.
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('features', 'purchasing', 'queries.ts')))
      .filter((path) => readFileSync(path, 'utf8').includes('queryKey: onOrderKeys.all'));

    expect(offenders).toEqual([]);
  });
});
