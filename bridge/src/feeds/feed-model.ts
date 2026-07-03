/**
 * Pure feed model (EI-6) — the Phase 80 activity feed as transport-neutral feed items.
 *
 * The syndication feeds (RSS / Atom / JSON Feed) all render the same thing: the cross-item
 * `item_history` activity log the app's own Activity screen projects (Phase 80). This module
 * turns one {@link ActivityFeedEntry} into a small, format-agnostic {@link FeedItem} the three
 * hand-rolled emitters ({@link ./emitters.ts}) each serialise — so the "what does an activity
 * row mean" logic lives in exactly one place and unit-tests without a database or an emitter.
 *
 * It reuses the **same seams** as the EI-1 event model — never a fork:
 *   - `describeHistoryEntry` — the action title / detail / signed-delta shaper (Phase 52/80);
 *   - `activityKindForAction` — the §4 action → semantic-kind grouping (Phase 80);
 *   - `eventTypeForAction`   — the stable dotted event type (EI-1), so a feed item's `type`
 *                              matches the webhook/SSE event for the same ledger row.
 *
 * Pure and deterministic: no clock, no I/O, no DB. The DB read (the recent-history page) lives
 * in {@link ./feed.ts}; this file only maps already-fetched rows.
 */
import { activityKindForAction, type ActivityKind } from '@/features/activity/activity-kind.ts';
import { describeHistoryEntry } from '@/features/inventory/history-format.ts';
import type { ActivityFeedEntry } from '@/db/repositories/types';
import { eventTypeForAction } from '../events/model.ts';

/**
 * One activity-feed entry, ready for any syndication format. `id` is the immutable ledger row
 * id (stable + unique, so a reader dedupes and updates in place); `type` is the same stable
 * dotted name the EI-1 event stream uses for the same row; `occurredAt` is the ledger row's
 * `created_at` (UNIX-ms), which each emitter renders in its own date format.
 */
export interface FeedItem {
  readonly id: string;
  readonly type: string;
  readonly kind: ActivityKind;
  /** A one-line human title, e.g. "ESP32 Dev Board — Quantity changed". */
  readonly title: string;
  /** A human summary sentence: the stored note when present, else the action label. */
  readonly summary: string;
  readonly itemId: string;
  readonly itemName: string;
  /** Whether the owning item is still active (a soft-deleted item's history still appears). */
  readonly itemActive: boolean;
  readonly occurredAt: number;
}

/**
 * Map one activity-ledger entry to a {@link FeedItem}. The title pairs the item name with the
 * British-English action label; the summary prefers the stored note (which already reads as a
 * sentence, e.g. "Gauge −45g (now 400g).") and falls back to the label when the note is blank.
 */
export function toFeedItem(entry: ActivityFeedEntry): FeedItem {
  const view = describeHistoryEntry(entry);
  return {
    id: entry.id,
    type: eventTypeForAction(entry.action),
    kind: activityKindForAction(entry.action),
    title: `${entry.itemName} — ${view.label}`,
    summary: view.detail ?? view.label,
    itemId: entry.itemId,
    itemName: entry.itemName,
    itemActive: entry.itemIsActive,
    occurredAt: entry.createdAt,
  };
}
