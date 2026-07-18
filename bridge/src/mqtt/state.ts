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
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { toLocationFieldValues, type LocationFieldValueDto } from '../api/dto.ts';
import { countStockLevels, forEachPage, MAX_LOCATIONS_SCANNED } from '../inventory-scan.ts';

/** How many locations' custom-field values to read concurrently (see {@link projectLocations}). */
const LOCATION_FIELD_READ_CHUNK = 25;

/** One location's published state: its id, name, live (active) item count and custom-field values. */
export interface LocationState {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
  /**
   * The custom-field values the location holds (the app's field dictionary), published as MQTT
   * attributes so an automation can read e.g. the entity id of the lamp above a shelf straight off
   * the sensor. Empty when the location has none.
   */
  readonly fieldValues: readonly LocationFieldValueDto[];
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
  const { lowStockItems, outOfStockItems } = await countStockLevels(items);
  const locations = await projectLocations(driver);
  return { itemsTotal, lowStockItems, outOfStockItems, locations, generatedAt: options.generatedAt };
}

/**
 * Collect every **user** location with its live item count. The built-in system buckets
 * (`Unassigned`, `In Transit`) are excluded: they are internal plumbing, so publishing them as
 * always-zero HA sensors would only be clutter — the summary `locationsTotal` likewise counts only
 * user locations, matching what the operator actually created.
 *
 * Each location's custom-field values are then read through the app's own repository seam (never
 * bespoke SQL, never a fork of the field dictionary's rules). The repository offers no batched
 * form, so it costs one query per user location — issued in concurrent chunks of
 * {@link LOCATION_FIELD_READ_CHUNK} rather than strictly serially, and bounded by the same
 * {@link MAX_LOCATIONS_SCANNED} ceiling the enumeration already obeys. Locations are a small
 * physical hierarchy (tens, not thousands), and this runs once per snapshot generation, not per
 * request.
 */
async function projectLocations(driver: IDatabaseDriver): Promise<LocationState[]> {
  const repo = new LocationRepository(driver);
  const categories = new CategoryRepository(driver);
  const rows: { id: string; name: string; itemCount: number }[] = [];
  await forEachPage(
    (limit, offset) => repo.list({ limit, offset }),
    MAX_LOCATIONS_SCANNED,
    (location) => {
      if (location.isSystem) return;
      rows.push({ id: location.id, name: location.name, itemCount: location.itemCount });
    },
  );

  const out: LocationState[] = [];
  // Read the field values in bounded batches rather than one strictly-serial await per location:
  // the reads are independent, so serialising them only multiplies the round-trip latency by the
  // location count. The chunk keeps a large hierarchy from opening thousands of reads at once.
  for (let i = 0; i < rows.length; i += LOCATION_FIELD_READ_CHUNK) {
    const chunk = rows.slice(i, i + LOCATION_FIELD_READ_CHUNK);
    const resolved = await Promise.all(
      chunk.map(async (row) => ({
        ...row,
        fieldValues: toLocationFieldValues(await categories.listLocationFieldValues(row.id)),
      })),
    );
    out.push(...resolved);
  }
  return out;
}
