/**
 * Shared bounded inventory-scan helpers — used by both the MQTT state projection (EI-5) and the
 * Prometheus metrics projection (EI-6).
 *
 * Both surfaces publish the same aggregate low/out-of-stock counts, and both must derive them from
 * the **exact same decision seams** as the EI-1 event model — `isLow` and `isOutOfStock` (both in
 * the app's reorder policy) with the app-default low-stock thresholds — so a published count can
 * never drift from the `item.low_stock` / `item.out_of_stock` events. Keeping that counting in one
 * place (rather than a copy per subsystem) makes the "counts can't drift" guarantee **structural**
 * rather than a convention two identical copies must both honour.
 *
 * Low-stock is opt-in (an item is low only against a positive reorder floor); **out-of-stock is
 * not** — a depleted item is counted whether or not it carries a reorder point, so the two counts
 * are computed independently and out-of-stock is *not* a subset of low-stock.
 *
 * Read-only and bounded: every scan pages at the repository ceiling up to a hard cap, so a
 * pathological vault can't produce an unbounded scan.
 */
import type { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants.ts';
import { isLow, isOutOfStock } from '@/features/inventory/reorder-policy.ts';
import type { Item, Page } from '@/db/repositories/types';
import { DEFAULT_LOW_STOCK } from './events/model.ts';

/**
 * Hard cap on how many items the low/out-of-stock scan walks. Generous enough never to bite a real
 * personal inventory while bounding the work on a pathological vault (past it, the low/out counts
 * are of the first {@link MAX_ITEMS_SCANNED} active items — the true item total is a separate
 * `count()` and is unaffected).
 */
export const MAX_ITEMS_SCANNED = 50_000;

/** Hard cap on how many locations a projection walks — locations are a small physical hierarchy. */
export const MAX_LOCATIONS_SCANNED = 10_000;

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
 * Count the active items that are low / out of stock, reusing the app's own `isLow` and
 * `isOutOfStock` (never a fork) so the counts match the low/out-of-stock events exactly.
 *
 * The two are independent: low-stock is opt-in (an item is low only against a positive reorder
 * floor), while out-of-stock is a plain fact of depletion — so an item at zero with no reorder
 * point is counted as out of stock even though it is not "low". Bounded by {@link MAX_ITEMS_SCANNED}.
 */
export async function countStockLevels(items: ItemRepository): Promise<StockLevelCounts> {
  let lowStockItems = 0;
  let outOfStockItems = 0;
  await forEachPage<Item>(
    (limit, offset) => items.list({ limit, offset }),
    MAX_ITEMS_SCANNED,
    (item) => {
      if (isLow(item, DEFAULT_LOW_STOCK)) lowStockItems += 1;
      if (isOutOfStock(item)) outOfStockItems += 1;
    },
  );
  return { lowStockItems, outOfStockItems };
}

/**
 * Walk a paginated repository read (paging at {@link MAX_PAGE_SIZE}, bounded by `maxScanned`),
 * invoking `onRow` for every row. Shared by the item scan and the per-location scans so the paging
 * / termination logic lives in one place.
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
