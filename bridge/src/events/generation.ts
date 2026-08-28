/**
 * Generation glue (EI-1) — the DB-facing seam between the watcher and the pure event model.
 *
 * The watcher re-hydrates a fresh driver on every snapshot change; this module reads that
 * driver's recent `item_history` page (through the app's own `getHistoryFeed`, never bespoke
 * SQL), diffs it against the previous cursor, resolves the per-item state each new row needs,
 * and hands the lot to the pure {@link buildEvents}. All impurity (the reads) lives here; the
 * mapping rules live in `model.ts` so they test without a database.
 *
 * Since issue #691 it does the same for the `location_history` ledger, through its own window on
 * the same cursor. The two are kept as separate reads and separate diffs rather than one merged
 * feed: they are different subjects with different payloads, and a burst in one must not evict the
 * other's baseline and make the next generation replay it.
 *
 * Strictly read-only: it only ever reads through the repositories.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { Item } from '@/db/repositories/types';
import { toItemSummary, type ItemSummaryDto } from '../api/dto.ts';
import { readLowStockThresholds } from '../low-stock-thresholds.ts';
import {
  buildEvents,
  buildLocationEvents,
  diffNewEntries,
  diffNewLocationEntries,
  DEFAULT_EVENT_SCAN_LIMIT,
  type BridgeEvent,
  type BuildEventsOptions,
  type EventCursor,
  type ResolvedEntry,
} from './model.ts';

/** Options controlling a generation's event computation. */
export interface GenerationOptions extends BuildEventsOptions {
  /** How many newest ledger rows to scan per generation (default {@link DEFAULT_EVENT_SCAN_LIMIT}). */
  readonly scanLimit?: number;
}

/**
 * Compute the events for one hydration generation. Returns the events to fan out (empty on the
 * baseline generation, per the cold-start rule) and the advanced cursor the caller must retain
 * for the next generation.
 */
export async function computeGenerationEvents(
  driver: IDatabaseDriver,
  previous: EventCursor | null,
  options: GenerationOptions = {},
): Promise<{ events: BridgeEvent[]; cursor: EventCursor }> {
  const items = new ItemRepository(driver);
  const locations = new LocationRepository(driver);
  const scanLimit = options.scanLimit ?? DEFAULT_EVENT_SCAN_LIMIT;
  // One bounded page of the newest rows from each ledger — the diff and the cursor both live inside
  // these windows (see EventCursor). Between two debounced snapshot syncs the delta is small; a rare
  // burst larger than a window surfaces its newest slice plus a truncation summary. The whole page
  // is kept, not just its rows, because the diff reads `hasMore` as well.
  const recent = await items.getHistoryFeed({ limit: scanLimit });
  const recentLocations = await locations.getHistoryFeed({ limit: scanLimit });

  // `hasMore` is the page's own "a full page came back", so it already reflects the repository
  // clamping an over-large `limit`. A window that did not fill holds the whole ledger, and only a
  // window that filled records a backfill floor (issue #642).
  const { newEntries, cursor, baseline } = diffNewEntries(previous, recent.rows, {
    windowFull: recent.hasMore,
  });
  const locationDiff = diffNewLocationEntries(previous, recentLocations.rows, {
    windowFull: recentLocations.hasMore,
  });
  // Both windows advance together, whichever of them actually moved — a generation that only
  // renamed a shelf must still carry the item ledger's baseline forward, and vice versa.
  const next: EventCursor = {
    ...cursor,
    locationSeenIds: locationDiff.locationSeenIds,
    locationBackfillFloor: locationDiff.locationBackfillFloor,
  };

  // Each ledger observes the cold-start rule independently: a first generation (or the first one
  // after an older build's cursor is resumed) establishes that window's baseline and emits nothing.
  const locationEvents =
    locationDiff.baseline || locationDiff.newEntries.length === 0
      ? []
      : buildLocationEvents(locationDiff.newEntries, options);

  if (baseline || newEntries.length === 0) return { events: locationEvents, cursor: next };

  const locationNames = new Map<string, string | null>();
  const resolved: ResolvedEntry[] = [];
  for (const entry of newEntries) {
    const item = (await items.getById(entry.itemId)) ?? null;
    resolved.push({ entry, item, summary: await toSummary(item, locations, locationNames) });
  }

  // The blanket low-stock thresholds are user preferences, so they live in the snapshot rather than
  // in this build's constants (issue #483). Reading them from *this* generation's driver is what
  // makes a threshold changed in Settings and synced take effect on the next hydration, exactly as
  // an item edit does. An explicit caller override still wins, and the read is deferred to here so
  // a generation with no item events to build never pays for it.
  const lowStockDefaults = options.lowStockDefaults ?? (await readLowStockThresholds(driver));
  const built = buildEvents(resolved, { ...options, lowStockDefaults });
  return { events: [...built, ...locationEvents], cursor: next };
}

/** Project an item to its summary DTO, resolving (and caching) its home-location name. */
async function toSummary(
  item: Item | null,
  locations: LocationRepository,
  cache: Map<string, string | null>,
): Promise<ItemSummaryDto | null> {
  if (item === null) return null;
  let locationName = cache.get(item.locationId);
  if (locationName === undefined) {
    locationName = (await locations.getById(item.locationId))?.name ?? null;
    cache.set(item.locationId, locationName);
  }
  return toItemSummary(item, locationName);
}
