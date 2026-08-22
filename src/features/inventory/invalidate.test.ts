/**
 * The write-side invalidation boundary (issue #166).
 *
 * `invalidateItems` is the broad, always-correct sweep every item write uses.
 * `invalidateItemStock` is its narrow counterpart for a write that moves **only** an item's
 * stock level (the quantity stepper, a gauge adjust): it deliberately leaves the
 * `item-attention` prefix cached, because the five status counts living there — on order,
 * warranty, on loan, overdue, maintenance due — are decided by fields and tables a stock write
 * never touches, and each carries a correlated per-row subquery.
 *
 * These tests pin the boundary in both directions. Getting it wrong is quiet in either
 * direction — too narrow leaves a stale chip count on screen, too broad silently gives back
 * the saving — so the prefixes are asserted explicitly rather than inferred.
 */
import { describe, it, expect, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { agendaKeys } from '@/features/calendar/keys';
import { reportKeys } from '@/features/reports/keys';
import { invalidateItemStock } from './invalidate';
import { inventoryKeys } from './queries';

/** A QueryClient stub that records the key of every invalidation. */
function stubClient() {
  const invalidateQueries = vi.fn();
  const keys = () => invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
  return { client: { invalidateQueries } as unknown as QueryClient, keys };
}

describe('invalidateItemStock — the narrow sweep (#166)', () => {
  // The broad `invalidateItems` is pinned in `report-invalidation.test.ts`, which owns the
  // items ⇄ reports invariant (#375); only the narrow helper is tested here.
  it('invalidates items, the expiring feed, reports and the agenda', () => {
    // The agenda rides along because the reorder-now lane is on-hand quantity against the reorder
    // point — the one thing a stock-only write is guaranteed to move (issue #374). The expiring
    // feed joined it for the mirror-image reason: it reads the item's *effective* expiry, which a
    // stock write moves whenever it receives a dated lot or empties the last one (issue #684).
    const { client, keys } = stubClient();
    invalidateItemStock(client);
    expect(keys()).toEqual([inventoryKeys.items(), inventoryKeys.expiring(), reportKeys.all, agendaKeys.all]);
  });

  it('leaves the item-attention prefix cached', () => {
    const { client, keys } = stubClient();
    invalidateItemStock(client);
    expect(keys()).not.toContainEqual(inventoryKeys.itemAttention());
  });

  it('still sweeps the stock-derived status counts, which live under items()', () => {
    // The saving only holds if the *stock-dependent* half is genuinely inside the prefix this
    // narrow sweep does invalidate — otherwise a stepper tap would leave "Out of stock (8)"
    // reading a number the tap just changed.
    const tuning = {
      locationId: null,
      lowStockThresholds: {},
      expirySoonWindowDays: 30,
      candidates: ['low-stock', 'out-of-stock'],
    } as const;
    const stockKey = inventoryKeys.applicableStatuses(tuning);
    expect(stockKey.slice(0, inventoryKeys.items().length)).toEqual([...inventoryKeys.items()]);

    // …and that the stable half is genuinely outside it, or the split saves nothing.
    const stableKey = inventoryKeys.stableStatuses(tuning);
    expect(stableKey.slice(0, inventoryKeys.items().length)).not.toEqual([...inventoryKeys.items()]);
  });
});
