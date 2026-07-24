/**
 * Prometheus/OpenMetrics projection (EI-6) — the aggregate inventory counts a Grafana/Prometheus
 * home-lab scrapes from `GET /metrics`.
 *
 * A **read-only projection through the app's own repositories** — never bespoke SQL, mirroring the
 * iCal feed and the MQTT state projection. The low/out-of-stock counts come from the shared
 * {@link countStockLevels} (reusing the app reorder policy's `isLow` / `isOutOfStock` seams), the
 * *same* helper the EI-5 MQTT state projection uses — so a scraped `gubbins_low_stock_items` can
 * never drift from the `item.low_stock` events or the MQTT `gubbins/summary` counts. Per-location
 * fullness reuses the app's own `locationFullness` seam (the maths behind the Edit-location gauge).
 *
 * Everything is bounded (paged at the repository ceiling up to {@link MAX_ITEMS_SCANNED} /
 * {@link MAX_LOCATIONS_SCANNED}), so a pathological vault can't produce an unbounded scan. The
 * pure serialisation lives in `metrics-format.ts`, so it tests without a database.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { locationFullness } from '@/features/inventory/location-fullness.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { LocationWithCount } from '@/db/repositories/types';
import { countStockLevels, forEachPage, MAX_LOCATIONS_SCANNED } from '../inventory-scan.ts';

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
  /** How many active items are fully depleted (counted independently of {@link lowStockItems}). */
  readonly outOfStockItems: number;
  /** How many user-defined locations exist (system buckets excluded). */
  readonly locationsTotal: number;
  /** Per-location metrics (system buckets excluded). */
  readonly locations: readonly LocationMetric[];
}

/**
 * Project the just-swapped, read-only driver into the aggregate {@link MetricsSnapshot}. Reads only
 * through the app repositories (`ItemRepository`, `LocationRepository`); never mutates. The
 * low/out-of-stock counts come from the shared {@link countStockLevels} (the same helper the MQTT
 * state projection uses), so the two surfaces can never disagree.
 */
export async function projectMetrics(driver: IDatabaseDriver): Promise<MetricsSnapshot> {
  const items = new ItemRepository(driver);
  const itemsTotal = await items.count();
  const { lowStockItems, outOfStockItems } = await countStockLevels(items);
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
