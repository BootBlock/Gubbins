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
import { projectKeys } from '@/features/projects/keys';
import { reportKeys } from '@/features/reports/keys';
import { inventoryKeys } from './queries';

/**
 * Refresh the project caches a **stock** change reaches (issue #653).
 *
 * A project's shopping list is no longer a function of its own BOM alone: a reservation reduces
 * what a line has to buy only to the extent real stock backs it, so selling, lending or writing
 * off units can turn another project's satisfied line into a shortfall without that project
 * being touched. The `projects` prefix is small and refetches only what something is observing,
 * so carrying it on every item write is cheap and always correct.
 */
function invalidateProjectsForStock(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: projectKeys.all });
}

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
  // Sibling of `items()`, not a child, so the prefix above misses it — the same shape as the
  // due-date feed named below. It moves on an expiry-date edit *and* on a stock write that
  // receives or empties a dated lot, since the feed reads the effective expiry (issue #684).
  void client.invalidateQueries({ queryKey: inventoryKeys.expiring() });
  // The other two attention feeds are siblings of `items()` in exactly the same way, and were
  // swept by nothing at all: a stock write left the Low Stock widget and the alert centre's
  // low-stock and warranty lanes showing pre-write rows until the screen was remounted, while
  // the reports prefix below refreshed the *counts* printed over them (issue #606).
  void client.invalidateQueries({ queryKey: inventoryKeys.lowStock() });
  void client.invalidateQueries({ queryKey: inventoryKeys.warrantyExpiring() });
  void client.invalidateQueries({ queryKey: reportKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
  // Named rather than delegated to `invalidateFieldDueDates`, which would sweep the agenda
  // prefix a second time: the alert-centre due-date feed is the only part not already covered
  // by the four above. It is a *sibling* of `items()`, not a child, so the prefix misses it.
  void client.invalidateQueries({ queryKey: inventoryKeys.fieldDueDates() });
  invalidateProjectsForStock(client);
}

/**
 * Refresh the opted-in custom-field due-date feeds (W1a) — the alert centre's `field-due` lane
 * and its Upcoming-agenda twin.
 *
 * Its own helper because the writes that move it are not the ones that move the item row: an
 * item's custom-field value, a *location's* inheritable value (which reaches every item beneath
 * it), and a definition's due-date opt-in all change what the lane reports without touching
 * `items` at all. Those call sites live in `features/inventory/categories.ts`; naming the sweep
 * once here is what stops one of them being missed — the shape issue #374 caught on the agenda.
 *
 * The feed's key sits under `inventoryKeys.all` rather than `items()`, exactly like the warranty
 * feed, so it is deliberately *not* carried by the `items()` prefix and must be swept by name.
 */
export function invalidateFieldDueDates(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.fieldDueDates() });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
}

/**
 * The narrow counterpart to {@link invalidateItems} for a write that changed **only an item's
 * stock level** — the quantity stepper, a gauge adjust (issue #166).
 *
 * Identical to `invalidateItems` except that it leaves the `itemAttention()` prefix alone. That
 * prefix holds the status counts a stock write cannot move — *on order*, *warranty*, *on loan*,
 * *overdue*, *maintenance due* — which are decided by fields and tables a stock write never
 * touches (see `STOCK_DEPENDENT_STATUSES`). They are also the expensive half: each carries a
 * correlated per-row subquery, so recomputing them per stepper tap was most of the cost of a tap.
 *
 * *Expiring* is **not** among them: a stock write that receives a dated lot, or draws the last
 * unit out of one, moves that count through the item's effective expiry (issue #684). Its status
 * count therefore lives under `items()` and is swept by the first line below, and the "Soon to
 * Expire" feed — a sibling key — is swept by name.
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
  void client.invalidateQueries({ queryKey: inventoryKeys.expiring() });
  // Low stock *is* stock-dependent — a stepper tap can cross a reorder point — so its feed is
  // swept here too. The warranty feed is not: no stock write can move a warranty date.
  void client.invalidateQueries({ queryKey: inventoryKeys.lowStock() });
  void client.invalidateQueries({ queryKey: reportKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
  invalidateProjectsForStock(client);
}
