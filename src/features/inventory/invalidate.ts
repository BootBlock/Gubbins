/**
 * Write-side cache invalidation for the inventory domain.
 *
 * Deliberately its own module rather than part of `./queries`: that module is the *read* seam
 * and a couple of dozen component tests replace it wholesale with a `vi.mock` factory listing
 * only the hooks they render. A helper living there would resolve to `undefined` inside any
 * mutation those tests happen to drive, so the write side keeps its own small, unmocked home.
 */
import type { QueryClient } from '@tanstack/react-query';
import { agendaKeys } from '@/features/calendar/keys';
import { reportKeys } from '@/features/reports/keys';
import { inventoryKeys } from './queries';

/**
 * Invalidate the item caches after a write, **and the reports and agenda that read them**.
 *
 * Every §3 report — inventory value, stock movement, consumption, ABC, turnover, dead stock,
 * spend, sales — is an aggregation over the same item and ledger rows the `items()` prefix
 * covers, so a write that reshapes one reshapes the other. Binding them into a single helper
 * is what stops the two drifting: `items()` used to be invalidated from forty sites and the
 * reports prefix from four, so a quantity or gauge adjustment left every report showing
 * pre-adjustment figures until the screen was remounted (issue #375).
 *
 * The "Upcoming" agenda joined for exactly the same reason (issue #374): four of its six lanes —
 * warranty expiry, perishable expiry, checkout due-back and reorder-now — are reads over those
 * same item rows, and the prefix was previously swept by booking writes alone, so editing an
 * expiry date or crossing a reorder point left the screen showing pre-write dates.
 *
 * Neither prefix is refetched unless something is observing it (TanStack marks the rest stale),
 * so carrying them on a write that happens not to move a reported figure or a dated event costs
 * nothing away from those screens — and is always correct on them.
 */
export function invalidateItems(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  void client.invalidateQueries({ queryKey: inventoryKeys.itemAttention() });
  void client.invalidateQueries({ queryKey: reportKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
}

/**
 * The narrow counterpart to {@link invalidateItems} for a write that changed **only an item's
 * stock level** — the quantity stepper, a gauge adjust (issue #166).
 *
 * Identical to `invalidateItems` except that it leaves the `itemAttention()` prefix alone. That
 * prefix holds the status counts a stock write cannot move — *on order*, *expiring*,
 * *warranty*, *on loan*, *overdue*, *maintenance due* — which are decided by fields and tables
 * a stock write never touches (see `STOCK_DEPENDENT_STATUSES`). They are also the expensive
 * half: each carries a correlated per-row subquery, so recomputing them per stepper tap was
 * most of the cost of a tap.
 *
 * **Use this only where that claim genuinely holds.** `invalidateItems` is the safe default and
 * the right choice for anything that touches a row's other fields, its active flag, or the
 * purchase-order / checkout / maintenance tables — over-invalidating merely costs a refetch,
 * whereas under-invalidating leaves a visibly stale chip count until the next broad write.
 *
 * The agenda prefix stays in the sweep: its reorder-now lane is `quantity` against the item's
 * reorder point, which is precisely what a stock write moves (issue #374). The lanes it *can't*
 * move are dated feeds that go stale only in date terms, so refreshing them here is harmless.
 */
export function invalidateItemStock(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  void client.invalidateQueries({ queryKey: reportKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
}
