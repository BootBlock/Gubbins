/**
 * Prometheus/OpenMetrics projection (EI-6) — the aggregate inventory counts a Grafana/Prometheus
 * home-lab scrapes from `GET /metrics`.
 *
 * A **read-only projection through the app's own repositories** — never bespoke SQL, mirroring the
 * iCal feed and the MQTT state projection. It reuses the **exact same decision seams** as the EI-1
 * event model and the EI-5 MQTT state — `isLow` (reorder policy) and `isStockEmpty` (the event
 * model) with the app-default thresholds — so a scraped `gubbins_low_stock_items` can never drift
 * from the `item.low_stock` events or the MQTT `gubbins/summary` counts. Per-location fullness
 * reuses the app's own `locationFullness` seam (the same maths behind the Edit-location gauge).
 *
 * Everything is bounded (paged at the repository ceiling up to {@link MAX_ITEMS_SCANNED} /
 * {@link MAX_LOCATIONS_SCANNED}), so a pathological vault can't produce an unbounded scan. The
 * pure serialisation lives in `metrics-format.ts`, so it tests without a database.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants.ts';
import { isLow } from '@/features/inventory/reorder-policy.ts';
import { locationFullness } from '@/features/inventory/location-fullness.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { Item, LocationWithCount, Page } from '@/db/repositories/types';
import { DEFAULT_LOW_STOCK, isStockEmpty } from '../events/model.ts';

/** One location's metrics row: its identity, item count, optional capacity and fullness ratio. */
export interface LocationMetric {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
  /** Configured capacity, or null when unbounded (no capacity/fullness gauge is emitted). */
  readonly capacity: number | null;
  /** itemCount / capacity as a 0..1+ ratio, or null when the location has no capacity. */
  readonly fullnessRatio: number | null;
}

/** The aggregate snapshot the `/metrics` exposition is rendered from. */
export interface MetricsSnapshot {
  /** Total active items across the vault. */
  readonly itemsTotal: number;
  /** How many active items are at/below their low-stock threshold. */
  readonly lowStockItems: number;
  /** How many active items are fully depleted (a subset of {@link lowStockItems}). */
  readonly outOfStockItems: number;
  /** How many user-defined locations exist (system buckets excluded). */
  readonly locationsTotal: number;
  /** Per-location metrics (system buckets excluded). */
  readonly locations: readonly LocationMetric[];
}

/**
 * Hard cap on how many items the low/out-of-stock scan walks. Generous enough never to bite a real
 * personal inventory while bounding the work on a pathological vault (past it, the low/out counts
 * are of the first {@link MAX_ITEMS_SCANNED} active items — `itemsTotal` still reports the true total).
 */
export const MAX_ITEMS_SCANNED = 50_000;

/** Hard cap on how many locations the projection walks — locations are a small physical hierarchy. */
export const MAX_LOCATIONS_SCANNED = 10_000;

/**
 * Project the just-swapped, read-only driver into the aggregate {@link MetricsSnapshot}. Reads only
 * through the app repositories (`ItemRepository`, `LocationRepository`); never mutates.
 */
export async function projectMetrics(driver: IDatabaseDriver): Promise<MetricsSnapshot> {
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
  return { itemsTotal, lowStockItems, outOfStockItems, locationsTotal: locations.length, locations };
}

/**
 * Collect every **user** location with its item count, capacity and fullness. The built-in system
 * buckets (`Unassigned`, `In Transit`) are excluded — they are internal plumbing, so scraping them
 * as always-present gauges would only be clutter (matching the MQTT state projection's posture).
 */
async function projectLocations(driver: IDatabaseDriver): Promise<LocationMetric[]> {
  const repo = new LocationRepository(driver);
  const out: LocationMetric[] = [];
  await forEachPage<LocationWithCount>(
    (limit, offset) => repo.list({ limit, offset }),
    MAX_LOCATIONS_SCANNED,
    (location) => {
      if (location.isSystem) return;
      const fullness = locationFullness(location.itemCount, location.capacity);
      out.push({
        id: location.id,
        name: location.name,
        itemCount: location.itemCount,
        capacity: location.capacity,
        fullnessRatio: fullness === null ? null : location.itemCount / location.capacity!,
      });
    },
  );
  return out;
}

/**
 * Walk a paginated repository read (paging at {@link MAX_PAGE_SIZE}, bounded by `maxScanned`),
 * invoking `onRow` for every row. Local to this module (parallels the identical helper in the MQTT
 * state projection) so the paging / termination logic stays beside the projection that uses it.
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
