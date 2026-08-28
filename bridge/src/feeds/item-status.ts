/**
 * Attention-status projection — the per-status counts behind `GET /api/v1/status` (issue #146).
 *
 * The app's inventory screen offers a fixed set of "attention" filters (*Low stock*, *Out of
 * stock*, *On order*, *Expiring*, *Warranty*, *On loan*, *Overdue*, *Maintenance due*), each with
 * a live match count. This projects the **same** counts for an outside consumer — a Home Assistant
 * binary sensor, a dashboard tile — so "3 items are low" over HTTP is the same 3 the app shows.
 *
 * Like the metrics and MQTT projections it is a **read-only projection through the app's own
 * repository**, never bespoke SQL: {@link ItemRepository.applicableStatuses} is the single query
 * (one conditional `SUM` per status, one pass over `items`), and each status inside it reuses its
 * own SSOT predicate. The low-stock thresholds come from the same {@link readLowStockThresholds}
 * the derived `item.low_stock` events and the `/metrics` counts read, so no bridge surface can
 * apply a different idea of "low" from another — and since `/metrics` now counts its two stock
 * statuses through this same repository seam, its figures are these figures, not merely thresholds
 * that agree.
 *
 * Unlike the app's filter bar, this deliberately probes **every** status rather than a
 * module-enabled subset: which modules are on is per-device UI state (the `gubbins:modules` store),
 * never part of the synced data the bridge hydrates, so there is no enabled set to narrow to here —
 * and narrowing would in any case report a real count as `0` to a client that has no filter bar to
 * hide the chip from.
 *
 * `applicableStatuses` omits zero counts (the filter bar hides a chip that matches nothing); an
 * API consumer needs the opposite — every status present, so "nothing is overdue" is a `0` rather
 * than a key a client has to know might be missing. The zero-fill happens here.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { ITEM_STATUS_FILTERS, type ItemStatusFilter } from '@/db/repositories/item/status-filter.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { readLowStockThresholds } from '../low-stock-thresholds.ts';

/** Every attention status mapped to how many active items currently match it (`0` included). */
export type ItemStatusCounts = Readonly<Record<ItemStatusFilter, number>>;

/**
 * Count the active items matching each attention status, in one pass over `items`. Every status in
 * {@link ITEM_STATUS_FILTERS} is present in the result, zero-filled — see the module note.
 */
export async function projectItemStatuses(driver: IDatabaseDriver): Promise<ItemStatusCounts> {
  const rows = await new ItemRepository(driver).applicableStatuses({
    // Read through the shared seam rather than left to the repository's own fallback, so this
    // count follows the user's blanket exactly as the event and `/metrics` surfaces do.
    lowStockThresholds: await readLowStockThresholds(driver),
  });
  const counted = new Map(rows.map((row) => [row.status, row.count]));
  const out = {} as Record<ItemStatusFilter, number>;
  for (const status of ITEM_STATUS_FILTERS) out[status] = counted.get(status) ?? 0;
  return out;
}
