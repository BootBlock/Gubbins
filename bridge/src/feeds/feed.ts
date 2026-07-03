/**
 * Activity-feed projection (EI-6) — the DB-facing glue between the app's Phase 80 activity log
 * and the pure feed model / emitters.
 *
 * A **read-only projection through the app's own repository** — never bespoke SQL, mirroring the
 * iCal feed and the MQTT state projection. It reads the newest slice of the cross-item
 * `item_history` ledger through `ItemRepository.getHistoryFeed` (the exact query the Activity
 * screen uses) and maps each row to a transport-neutral {@link FeedItem} via the pure
 * {@link toFeedItem}. All impurity (the read) lives here; the mapping rules and the serialisation
 * live in `feed-model.ts` / `emitters.ts`, so they test without a database.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { toFeedItem, type FeedItem } from './feed-model.ts';

/**
 * How many of the newest activity-ledger rows a feed carries. A feed is a "recent activity"
 * window, not a full export (that is what the REST API / CSV are for), so it is bounded — this
 * is also the repository's page ceiling, so it is one read.
 */
export const DEFAULT_FEED_LIMIT = 50;

/** Options for {@link buildActivityFeed}. */
export interface ActivityFeedOptions {
  /** Max entries to include (clamped to [1, {@link DEFAULT_FEED_LIMIT}]). */
  readonly limit?: number;
}

/**
 * Build the recent-activity feed items from the just-swapped, read-only driver: the newest
 * `limit` ledger rows (newest-first, as `getHistoryFeed` returns them), each mapped to a
 * {@link FeedItem}. Pure w.r.t. inventory (never mutates).
 */
export async function buildActivityFeed(
  driver: IDatabaseDriver,
  options: ActivityFeedOptions = {},
): Promise<FeedItem[]> {
  const limit = clampLimit(options.limit ?? DEFAULT_FEED_LIMIT);
  const page = await new ItemRepository(driver).getHistoryFeed({ limit });
  return page.rows.map(toFeedItem);
}

/** Clamp a requested feed size to [1, {@link DEFAULT_FEED_LIMIT}]. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_FEED_LIMIT;
  return Math.max(1, Math.min(DEFAULT_FEED_LIMIT, Math.floor(limit)));
}
