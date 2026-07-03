/**
 * Generation glue (EI-1) — the DB-facing seam between the watcher and the pure event model.
 *
 * The watcher re-hydrates a fresh driver on every snapshot change; this module reads that
 * driver's recent `item_history` page (through the app's own `getHistoryFeed`, never bespoke
 * SQL), diffs it against the previous cursor, resolves the per-item state each new row needs,
 * and hands the lot to the pure {@link buildEvents}. All impurity (the reads) lives here; the
 * mapping rules live in `model.ts` so they test without a database.
 *
 * Strictly read-only: it only ever reads through the repositories.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { Item } from '@/db/repositories/types';
import { toItemSummary, type ItemSummaryDto } from '../api/dto.ts';
import {
  buildEvents,
  diffNewEntries,
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
  const scanLimit = options.scanLimit ?? DEFAULT_EVENT_SCAN_LIMIT;
  // One bounded page of the newest ledger rows — the diff and the cursor both live inside this
  // window (see EventCursor). Between two debounced snapshot syncs the delta is small; a rare
  // burst larger than the window surfaces its newest slice plus a truncation summary.
  const recent = (await items.getHistoryFeed({ limit: scanLimit })).rows;

  const { newEntries, cursor, baseline } = diffNewEntries(previous, recent);
  if (baseline || newEntries.length === 0) return { events: [], cursor };

  const locations = new LocationRepository(driver);
  const locationNames = new Map<string, string | null>();
  const resolved: ResolvedEntry[] = [];
  for (const entry of newEntries) {
    const item = (await items.getById(entry.itemId)) ?? null;
    resolved.push({ entry, item, summary: await toSummary(item, locations, locationNames) });
  }

  return { events: buildEvents(resolved, options), cursor };
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
