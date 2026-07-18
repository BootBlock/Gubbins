/**
 * Write-side cache invalidation for the inventory domain.
 *
 * Deliberately its own module rather than part of `./queries`: that module is the *read* seam
 * and a couple of dozen component tests replace it wholesale with a `vi.mock` factory listing
 * only the hooks they render. A helper living there would resolve to `undefined` inside any
 * mutation those tests happen to drive, so the write side keeps its own small, unmocked home.
 */
import type { QueryClient } from '@tanstack/react-query';
import { reportKeys } from '@/features/reports/keys';
import { inventoryKeys } from './queries';

/**
 * Invalidate the item caches after a write, **and the reports that read them**.
 *
 * Every §3 report — inventory value, stock movement, consumption, ABC, turnover, dead stock,
 * spend, sales — is an aggregation over the same item and ledger rows the `items()` prefix
 * covers, so a write that reshapes one reshapes the other. Binding them into a single helper
 * is what stops the two drifting: `items()` used to be invalidated from forty sites and the
 * reports prefix from four, so a quantity or gauge adjustment left every report showing
 * pre-adjustment figures until the screen was remounted (issue #375).
 *
 * Reports are only refetched while something is observing them (TanStack marks the rest
 * stale), so carrying the extra prefix on a write that happens not to move a reported figure
 * costs nothing away from the Reports screen — and is always correct on it.
 */
export function invalidateItems(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  void client.invalidateQueries({ queryKey: reportKeys.all });
}
