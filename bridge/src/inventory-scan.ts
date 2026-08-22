/**
 * Shared inventory-aggregate helpers — used by both the MQTT state projection (EI-5) and the
 * Prometheus metrics projection (EI-6).
 *
 * Both surfaces publish the same aggregate low/out-of-stock counts, and both must derive them from
 * the **exact same decision seams** as the EI-1 event model, so a published count can never drift
 * from the `item.low_stock` / `item.out_of_stock` events. Keeping that counting in one place
 * (rather than a copy per subsystem) makes the "counts can't drift" guarantee **structural** rather
 * than a convention two identical copies must both honour.
 *
 * The counting is a whole-table aggregate through the app's own `applicableStatuses` — the same
 * repository seam `/api/v1/status` uses — so it is a single query per projection whatever the
 * inventory's size, and its `low-stock` / `out-of-stock` fragments are the app's SSOT predicates.
 * Those are held to the same answer as the pure `isLow` / `isOutOfStock` seams the events use by
 * the app's own drift guard (`stock-attention-parity.test.ts`), and the thresholds are the shared
 * {@link DEFAULT_LOW_STOCK} — so the SQL and in-memory definitions cannot part company.
 *
 * It used to page fully-hydrated items into JavaScript instead and apply the pure seams row by
 * row, capped at 50,000 active items: 500 sequential reads on every Prometheus scrape, and past
 * the cap a partial count published as though it covered the whole vault (issue #532). An
 * aggregate has no cap to truncate at.
 *
 * Read-only throughout. The per-location walks still page at the repository ceiling up to a hard
 * cap ({@link forEachPage} / {@link MAX_LOCATIONS_SCANNED}), so a pathological hierarchy can't
 * produce an unbounded scan.
 *
 * Low-stock is opt-in (an item is low only against a positive reorder floor); **out-of-stock is
 * not** — a depleted item is counted whether or not it carries a reorder point, so the two counts
 * are computed independently and out-of-stock is *not* a subset of low-stock.
 */
import type { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants.ts';
import type { ItemStatusFilter } from '@/db/repositories/item/status-filter.ts';
import type { Page } from '@/db/repositories/types';
import { DEFAULT_LOW_STOCK } from './events/model.ts';

/** Hard cap on how many locations a projection walks — locations are a small physical hierarchy. */
export const MAX_LOCATIONS_SCANNED = 10_000;

/**
 * The two attention statuses that answer {@link StockLevelCounts}. Probed together, so both counts
 * come out of a single pass over `items` — and only these two, so the pass never computes the
 * correlated purchase-order / checkout / maintenance probes whose answers nothing here publishes.
 *
 * Spelled out rather than reusing the app's `STOCK_DEPENDENT_STATUSES`, which is a wider set: that
 * list means "a stock write can move this count", which is a question about cache invalidation.
 * {@link StockLevelCounts} has one field per entry here, so a status joining that list should not
 * silently start being probed for a figure this has nowhere to put.
 */
const STOCK_LEVEL_STATUSES: readonly ItemStatusFilter[] = ['low-stock', 'out-of-stock'];

/** The aggregate stock-level counts. Out-of-stock is counted independently of low-stock. */
export interface StockLevelCounts {
  /** How many active items are at/below their (opt-in) low-stock threshold. */
  readonly lowStockItems: number;
  /**
   * How many active items are fully depleted. Not opt-in and **not** a subset of
   * {@link lowStockItems}: a depleted item counts here even with no reorder point set.
   */
  readonly outOfStockItems: number;
}

/**
 * Count the active items that are low / out of stock across the **whole** inventory, reusing the
 * app's own `low-stock` / `out-of-stock` predicates (never a fork) so the counts match the
 * low/out-of-stock events — and `/api/v1/status`, which counts through the same seam — exactly.
 *
 * The two are independent: low-stock is opt-in (an item is low only against a positive reorder
 * floor), while out-of-stock is a plain fact of depletion — so an item at zero with no reorder
 * point is counted as out of stock even though it is not "low".
 */
export async function countStockLevels(items: ItemRepository): Promise<StockLevelCounts> {
  const counts = await items.applicableStatuses({
    candidates: STOCK_LEVEL_STATUSES,
    // Passed explicitly (rather than left to the repository's own fallback) so the link to the
    // event thresholds is visible here: if those move, these counts move with them.
    lowStockThresholds: DEFAULT_LOW_STOCK,
  });
  // `applicableStatuses` omits a status nothing matches (the filter bar hides an empty chip), so
  // an absent entry is a real zero rather than a missing answer.
  const byStatus = new Map(counts.map((row) => [row.status, row.count]));
  return {
    lowStockItems: byStatus.get('low-stock') ?? 0,
    outOfStockItems: byStatus.get('out-of-stock') ?? 0,
  };
}

/**
 * Walk a paginated repository read (paging at {@link MAX_PAGE_SIZE}, bounded by `maxScanned`),
 * invoking `onRow` for every row. Shared by both projections' per-location scans so the paging /
 * termination logic lives in one place.
 */
export async function forEachPage<T>(
  read: (limit: number, offset: number) => Promise<Page<T>>,
  maxScanned: number,
  onRow: (row: T) => void,
): Promise<void> {
  for (let offset = 0; offset < maxScanned; offset += MAX_PAGE_SIZE) {
    const page = await read(MAX_PAGE_SIZE, offset);
    for (const row of page.rows) onRow(row);
    if (!page.hasMore) break;
  }
}
