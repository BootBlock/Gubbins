/**
 * Inventory-state projection for MQTT publishing (EI-5).
 *
 * A **read-only projection through the app's own repositories** — never bespoke SQL — mirroring
 * the iCal feed's posture. It computes the small, aggregate state the bridge publishes as retained
 * MQTT topics (and that Home Assistant turns into sensors): the total active item count, the
 * low-stock and out-of-stock counts, and a per-location item count.
 *
 * The low-stock / out-of-stock counts reuse the **exact same seams** as the EI-1 event model —
 * `isLow` (reorder policy) and `isStockEmpty` (the event model) with the app-default thresholds —
 * so the published counts can never drift from the `item.low_stock` / `item.out_of_stock` events.
 * Everything is bounded (paged at the repository ceiling up to {@link MAX_ITEMS_SCANNED}) so a huge
 * vault can't produce an unbounded scan.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants.ts';
import { isLow } from '@/features/inventory/reorder-policy.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { Item, Page } from '@/db/repositories/types';
import { DEFAULT_LOW_STOCK, isStockEmpty } from '../events/model.ts';

/** One location's published state: its id, name and live (active) item count. */
export interface LocationState {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
}

/** The aggregate inventory state published to the retained MQTT topics. */
export interface InventoryState {
  /** Total active items across the vault. */
  readonly itemsTotal: number;
  /** How many active items are at/below their low-stock threshold. */
  readonly lowStockItems: number;
  /** How many active items are fully depleted (a subset of {@link lowStockItems}). */
  readonly outOfStockItems: number;
  /** Per-location item counts (for the per-location sensors). */
  readonly locations: readonly LocationState[];
  /** The snapshot's generation instant as ISO-8601 (or null when unknown). */
  readonly generatedAt: string | null;
}

/**
 * Hard cap on how many items the low/out-of-stock scan walks. Generous enough never to bite a real
 * personal inventory while bounding the work on a pathological vault (past it, the counts are of
 * the first {@link MAX_ITEMS_SCANNED} active items — `itemsTotal` still reports the true total).
 */
export const MAX_ITEMS_SCANNED = 50_000;

/** Hard cap on how many locations the projection walks — locations are a small physical hierarchy. */
export const MAX_LOCATIONS_SCANNED = 10_000;

/** Options for {@link projectInventoryState}. */
export interface InventoryStateOptions {
  /** The snapshot's generation instant (ISO-8601) to stamp on the summary payload. */
  readonly generatedAt: string | null;
}

/**
 * Project the just-swapped, read-only driver into the aggregate {@link InventoryState}. Reads only
 * through the app repositories (`ItemRepository`, `LocationRepository`); never mutates.
 */
export async function projectInventoryState(
  driver: IDatabaseDriver,
  options: InventoryStateOptions,
): Promise<InventoryState> {
  const items = new ItemRepository(driver);
  const itemsTotal = await items.count();

  let lowStockItems = 0;
  let outOfStockItems = 0;
  await forEachPage<Item>(
    (limit, offset) => items.list({ limit, offset }),
    MAX_ITEMS_SCANNED,
    (item) => {
      if (!isLow(item, DEFAULT_LOW_STOCK)) return;
      lowStockItems += 1;
      if (isStockEmpty(item)) outOfStockItems += 1;
    },
  );

  const locations = await projectLocations(driver);
  return { itemsTotal, lowStockItems, outOfStockItems, locations, generatedAt: options.generatedAt };
}

/**
 * Collect every **user** location with its live item count. The built-in system buckets
 * (`Unassigned`, `In Transit`) are excluded: they are internal plumbing, so publishing them as
 * always-zero HA sensors would only be clutter — the summary `locationsTotal` likewise counts only
 * user locations, matching what the operator actually created.
 */
async function projectLocations(driver: IDatabaseDriver): Promise<LocationState[]> {
  const repo = new LocationRepository(driver);
  const out: LocationState[] = [];
  await forEachPage(
    (limit, offset) => repo.list({ limit, offset }),
    MAX_LOCATIONS_SCANNED,
    (location) => {
      if (location.isSystem) return;
      out.push({ id: location.id, name: location.name, itemCount: location.itemCount });
    },
  );
  return out;
}

/**
 * Walk a paginated repository read (paging at {@link MAX_PAGE_SIZE}, bounded by `maxScanned`),
 * invoking `onRow` for every row. Shared by the item scan and the location scan so the paging /
 * termination logic lives in one place.
 */
async function forEachPage<T>(
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
