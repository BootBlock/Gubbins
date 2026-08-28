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
import { QueryClient } from '@tanstack/react-query';
import { emptyAst } from '@/db/search/ast';
import { agendaKeys } from '@/features/calendar/keys';
import { projectKeys } from '@/features/projects/keys';
import { reportKeys } from '@/features/reports/keys';
import { invalidateItems, invalidateItemStock } from './invalidate';
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
  it('invalidates items, the expiring and low-stock feeds, reports, the agenda and the projects', () => {
    // The agenda rides along because the reorder-now lane is on-hand quantity against the reorder
    // point — the one thing a stock-only write is guaranteed to move (issue #374). The expiring
    // feed joined it for the mirror-image reason: it reads the item's *effective* expiry, which a
    // stock write moves whenever it receives a dated lot or empties the last one (issue #684).
    // The low-stock feed joined because a quantity or gauge write is precisely what puts an item
    // into it or clears it out of one (issue #623).
    // The projects prefix rides along because a project's shopping list reads stock: a
    // reservation reduces what a line has to buy only to the extent stock backs it, so selling
    // or lending units can turn another project's satisfied line into a shortfall (issue #653).
    const { client, keys } = stubClient();
    invalidateItemStock(client);
    expect(keys()).toEqual([
      inventoryKeys.items(),
      inventoryKeys.expiring(),
      inventoryKeys.lowStock(),
      reportKeys.all,
      agendaKeys.all,
      projectKeys.all,
    ]);
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

describe('the Visual-Builder search keys (#622)', () => {
  // The AST search caches item rows, so both sweeps have to reach it. It used to hang off a
  // *sibling* prefix of `items()`, which no item write touched: while the builder drove the
  // Inventory list, a ± tap wrote the new quantity and the card never moved, an edit left the
  // card behind the dialog stale, and a removed item kept its row. Nothing recovered it either —
  // the client does not refetch on window focus, and the user is parked on the screen.
  const AST = emptyAst();

  it.each([
    ['results', inventoryKeys.astSearch(AST, null, null)],
    ['count', inventoryKeys.astCount(AST, null)],
  ])('the %s key sits under items(), so both helpers sweep it by prefix', (_name, key) => {
    expect(key.slice(0, inventoryKeys.items().length)).toEqual([...inventoryKeys.items()]);
  });

  it('keeps the results and the count distinguishable by shape, not merely by length', () => {
    // The write side matches result pages by prefix in order to patch them optimistically, and
    // the count caches a bare number the `InfiniteData` updater would crash on. Sharing an
    // `'ast'` segment left the two the same length, separable only by inspecting the last one.
    const results = inventoryKeys.astSearch(AST, null, null);
    const count = inventoryKeys.astCount(AST, null);
    const shared = inventoryKeys.search().length;
    expect(results[shared]).not.toEqual(count[shared]);
  });
});

/**
 * The alert centre's feeds, driven through a **real** `QueryClient` (issue #623).
 *
 * The suites above pin the exact list of keys each helper names, which is what catches a sweep
 * being dropped. It cannot catch the failure that actually shipped: a feed the alert centre
 * reads that no sweep ever reached, because a list nobody added the key to still matches itself.
 *
 * So this drives the real prefix matcher instead. Each lane is seeded as a cache entry under the
 * key its reader genuinely uses, the helper runs, and the entry is asked whether it went stale.
 * It therefore asks about reachability, not spelling: a lane nested under `items()` and a lane
 * named explicitly both satisfy the first test, so a future fix is free to take either shape. The
 * second test is narrower on purpose — it pins *which* lanes the stock-only sweep reaches, so
 * moving the warranty or due-date feed under `items()` would fail it, which is the point.
 *
 * Why it matters on this surface: `AppNav` is mounted for the whole session and the client sets
 * `refetchOnWindowFocus: false`, so a feed with no invalidation has no refetch trigger at all
 * while the user stays on one screen. Restock an item and the badge kept counting it.
 */
describe('the alert-centre feeds go stale on an item write (#623)', () => {
  // The key each lane's reader actually passes to `useQuery`, not a prefix: `useLowStockItems`
  // keys on the user's thresholds and `useExpiringItems` on their window, so seeding the bare
  // prefix would prove less than the app needs.
  const LANES = {
    'low stock': inventoryKeys.lowStockFor({ qtyThreshold: 2, gaugePercent: 20 }),
    'soon to expire': inventoryKeys.expiringWithin(30),
    'warranty expiring': inventoryKeys.warrantyExpiring(),
    'custom-field due dates': inventoryKeys.fieldDueDatesWithin(null),
  } as const;

  /** Seed every lane, run `sweep`, and report which lanes it marked stale. */
  function sweptBy(sweep: (client: QueryClient) => void): string[] {
    const client = new QueryClient();
    for (const key of Object.values(LANES)) client.setQueryData(key, []);
    sweep(client);
    const stale = Object.entries(LANES)
      .filter(([, key]) => client.getQueryState(key)?.isInvalidated === true)
      .map(([lane]) => lane);
    client.clear();
    return stale;
  }

  it('invalidateItems reaches every lane', () => {
    expect(sweptBy(invalidateItems).sort()).toEqual(Object.keys(LANES).sort());
  });

  it('invalidateItemStock reaches the lanes a stock write can move, and no others', () => {
    // Low stock is quantity against the reorder point, and the expiry feed reads the item's
    // *effective* expiry — receiving a dated lot or emptying the last one moves it (#684).
    // Warranty reads `warranty_expires_at` and the custom-field lane reads field values: a
    // stock-only write cannot move either, and both are swept by `invalidateItems` instead.
    expect(sweptBy(invalidateItemStock).sort()).toEqual(['low stock', 'soon to expire']);
  });
});
