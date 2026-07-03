/**
 * Pure event model (EI-1) — the `item_history` ledger delta as typed events.
 *
 * The bridge already re-hydrates old → new on every snapshot change ({@link watcher.ts}).
 * This module turns the **new-since-last-generation** slice of the immutable `item_history`
 * ledger — the exact rows the Phase 80 activity feed projects — into a stable, transport-
 * agnostic event DTO that the webhook and SSE sinks both consume without forking anything.
 *
 * It is deliberately **pure**: no DB, no clock, no I/O, no `node:http`. The DB reads (the
 * recent-history page and the per-item lookups) happen in {@link generation.ts}; this file
 * only maps already-fetched rows to events, so every rule here unit-tests directly.
 *
 * Two seams are reused verbatim, never re-implemented (per the plan's "do NOT fork them"):
 *   - `activityKindForAction` — the §4 action → semantic-kind grouping (Phase 80).
 *   - `describeHistoryEntry` — the action title / detail / signed-delta shaper (Phase 52/80).
 *
 * Cold-start rule: the very first generation after a (re)start establishes a **baseline** and
 * emits nothing — it must never replay the pre-existing ledger as a burst of "new" events.
 */
import { activityKindForAction, type ActivityKind } from '@/features/activity/activity-kind.ts';
import { describeHistoryEntry } from '@/features/inventory/history-format.ts';
import { isLow, type ReorderDefaults, type ReorderItem } from '@/features/inventory/reorder-policy.ts';
import { LOW_STOCK_GAUGE_PERCENT, LOW_STOCK_QTY_THRESHOLD } from '@/db/repositories/constants.ts';
import type { HistoryAction } from '@/db/repositories/constants.ts';
import type { ActivityFeedEntry, Item } from '@/db/repositories/types';
import type { ItemSummaryDto } from '../api/dto.ts';

/**
 * A single typed event. `type` is a stable dotted name (`item.created`, `stock.adjusted`,
 * `item.low_stock`, …); `id` is deterministic (ledger-row-derived) so every sink can dedupe;
 * `occurredAt` is the ledger row's `created_at` as ISO-8601; `data` reuses the existing
 * `api/dto.ts` item shape.
 */
export interface BridgeEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: BridgeEventData;
}

/** The payload of a ledger-derived event: the change plus the item's current summary. */
export interface BridgeEventData {
  readonly itemId: string;
  readonly itemName: string;
  /** The raw §4 ledger action (e.g. `QUANTITY_CHANGE`). */
  readonly action: HistoryAction;
  /** The semantic activity kind the action folds into (Phase 80 grouping). */
  readonly kind: ActivityKind;
  /** Short British-English action title (e.g. "Quantity changed"). */
  readonly label: string;
  /** The stored human-readable note, or null. */
  readonly detail: string | null;
  /** A signed delta badge ("+3" / "−45.5"), or null when there was no movement. */
  readonly delta: string | null;
  readonly quantityDelta: number | null;
  readonly netValueDelta: number | null;
  /** The item's current summary (null when the item is no longer present). */
  readonly item: ItemSummaryDto | null;
}

/** The special event emitted when a single generation's fan-out is capped. */
export const EVENTS_TRUNCATED_TYPE = 'events.truncated';

/**
 * A resolved new ledger entry: the joined feed row plus the item's current state (used both
 * for the event's summary payload and the low-stock/out-of-stock derivation). `item` is null
 * when the item row could not be read (e.g. hard-deleted between generations).
 */
export interface ResolvedEntry {
  readonly entry: ActivityFeedEntry;
  readonly item: Item | null;
  readonly summary: ItemSummaryDto | null;
}

/**
 * A resumption cursor: the ids present in the **previous scan window** (the newest `scanLimit`
 * ledger rows). A row is "new" when its id is **absent** from this set — an id-based diff rather
 * than a `created_at` high-water mark, so an out-of-order row synced from another device (whose
 * `created_at` predates a change the bridge already saw — §7.3 union-by-id keeps each row's own
 * timestamp) is still detected, not silently skipped. `null` means "no baseline yet" (the
 * pre-first-generation state). The set is bounded by the scan window, so it can't grow without
 * limit; the trade-off is that a burst of more than `scanLimit` new rows in a single generation
 * only surfaces the newest window (a `events.truncated` summary flags the shortfall — a bulk
 * import is better consumed via the REST API than the event stream).
 */
export interface EventCursor {
  readonly seenIds: readonly string[];
}

/** Default page size when scanning the recent ledger for new rows (== the repo page ceiling). */
export const DEFAULT_EVENT_SCAN_LIMIT = 100;
/**
 * Default cap on how many events one generation may fan out. A bulk import writes one snapshot
 * with many new ledger rows; without a cap that would flood every downstream sink. Beyond the
 * cap the batch is truncated and a single {@link EVENTS_TRUNCATED_TYPE} summary event is
 * appended so consumers know changes were omitted.
 */
export const DEFAULT_FAN_OUT_CAP = 50;

/** The low-stock thresholds the derived `item.low_stock` event uses (the app defaults). */
export const DEFAULT_LOW_STOCK: ReorderDefaults = {
  qtyThreshold: LOW_STOCK_QTY_THRESHOLD,
  gaugePercent: LOW_STOCK_GAUGE_PERCENT,
};

/**
 * The stable dotted event type for each §4 ledger action. Grouped so related actions share a
 * type (e.g. all "coming into existence" actions are `item.created`). A forward-compat action a
 * newer peer synced falls back to `item.changed` (mirroring the activity-kind graceful
 * degradation) rather than crashing.
 */
const ACTION_EVENT_TYPE: Record<HistoryAction, string> = {
  CREATED: 'item.created',
  VARIANT_CREATED: 'item.created',
  ASSEMBLED: 'item.created',
  RENAMED: 'item.renamed',
  QUANTITY_CHANGE: 'stock.adjusted',
  GAUGE_UPDATE: 'stock.adjusted',
  RECONCILED: 'stock.adjusted',
  CONSUMED: 'stock.adjusted',
  RECEIVED: 'stock.adjusted',
  PROCURED: 'stock.adjusted',
  MOVED: 'item.moved',
  RE_PARENTED: 'item.moved',
  CHECKED_OUT: 'item.checked_out',
  CHECKED_IN: 'item.checked_in',
  RESERVED: 'item.reserved',
  RESERVATION_CLEARED: 'item.reservation_cleared',
  SOFT_DELETED: 'item.removed',
  RESTORED: 'item.restored',
  CONDITION_CHANGED: 'item.condition_changed',
  TRACKING_CHANGED: 'item.tracking_changed',
  MAINTENANCE_LOGGED: 'item.maintenance_logged',
  SCRAPE_APPLIED: 'item.supplier_data_applied',
};

/** The dotted event type for a ledger action (unknown actions → `item.changed`). */
export function eventTypeForAction(action: string): string {
  return ACTION_EVENT_TYPE[action as HistoryAction] ?? 'item.changed';
}

/** The actions that move stock — the ones that can additionally raise a low/out-of-stock event. */
function isStockAction(action: HistoryAction): boolean {
  return eventTypeForAction(action) === 'stock.adjusted';
}

/**
 * Compute the delta of the recent ledger against the previous cursor: the rows whose ids were
 * not in the last scan window, **oldest-first** (natural emission order), plus the advanced
 * cursor (this window's ids).
 *
 * `recent` must be the ledger's newest-first page (exactly what `getHistoryFeed` returns).
 * When `previous` is `null` this is the first generation: we establish the baseline from
 * `recent` and emit nothing (`baseline: true`) — no history replay. An empty `recent` (e.g. all
 * history pruned) holds the previous seen-set rather than forgetting it.
 */
export function diffNewEntries(
  previous: EventCursor | null,
  recent: readonly ActivityFeedEntry[],
): { newEntries: ActivityFeedEntry[]; cursor: EventCursor; baseline: boolean } {
  const cursor: EventCursor = {
    seenIds: recent.length > 0 ? recent.map((e) => e.id) : (previous?.seenIds ?? []),
  };
  if (previous === null) {
    return { newEntries: [], cursor, baseline: true };
  }
  const seen = new Set(previous.seenIds);
  const newEntries = recent.filter((e) => !seen.has(e.id)).reverse(); // newest-first → oldest-first
  return { newEntries, cursor, baseline: false };
}

/** Options for {@link buildEvents}. */
export interface BuildEventsOptions {
  /** Max events before the batch is truncated (default {@link DEFAULT_FAN_OUT_CAP}). */
  readonly fanOutCap?: number;
  /** Low-stock thresholds for the derived status events (default {@link DEFAULT_LOW_STOCK}). */
  readonly lowStockDefaults?: ReorderDefaults;
}

/**
 * Map resolved new entries (oldest-first) to the flat event list, applying the fan-out cap.
 *
 * Each entry yields one base event (its action type) and — for a stock movement that leaves the
 * item low or empty — one derived status event (`item.out_of_stock` when empty, else
 * `item.low_stock`). If the flat list exceeds `fanOutCap`, it is truncated to the cap and a
 * single {@link EVENTS_TRUNCATED_TYPE} summary event (carrying the omitted count) is appended.
 */
export function buildEvents(
  resolved: readonly ResolvedEntry[],
  options: BuildEventsOptions = {},
): BridgeEvent[] {
  const cap = Math.max(1, options.fanOutCap ?? DEFAULT_FAN_OUT_CAP);
  const defaults = options.lowStockDefaults ?? DEFAULT_LOW_STOCK;

  const all: BridgeEvent[] = [];
  for (const resolvedEntry of resolved) {
    all.push(baseEvent(resolvedEntry));
    const status = statusEvent(resolvedEntry, defaults);
    if (status !== null) all.push(status);
  }

  if (all.length <= cap) return all;
  const kept = all.slice(0, cap);
  const omitted = all.length - cap;
  kept.push(truncationEvent(kept[kept.length - 1]!, omitted));
  return kept;
}

/** The base event for a ledger entry (its action's dotted type + the shaped payload). */
function baseEvent({ entry, summary }: ResolvedEntry): BridgeEvent {
  const view = describeHistoryEntry(entry);
  return {
    id: entry.id,
    type: eventTypeForAction(entry.action),
    occurredAt: new Date(entry.createdAt).toISOString(),
    data: {
      itemId: entry.itemId,
      itemName: entry.itemName,
      action: entry.action,
      kind: activityKindForAction(entry.action),
      label: view.label,
      detail: view.detail,
      delta: view.delta,
      quantityDelta: entry.quantityDelta,
      netValueDelta: entry.netValueDelta,
      item: summary,
    },
  };
}

/**
 * The derived low/out-of-stock event for a stock movement, or null when the item is not a
 * stock item, is not low, or could not be resolved. The id suffixes the base ledger id so it
 * is deterministic and distinct (a sink can dedupe on it).
 */
function statusEvent(resolved: ResolvedEntry, defaults: ReorderDefaults): BridgeEvent | null {
  const { entry, item, summary } = resolved;
  if (item === null || !isStockAction(entry.action)) return null;
  if (!isLow(item, defaults)) return null;

  const empty = isStockEmpty(item);
  const type = empty ? 'item.out_of_stock' : 'item.low_stock';
  const base = baseEvent(resolved);
  return {
    id: `${entry.id}:${empty ? 'out_of_stock' : 'low_stock'}`,
    type,
    occurredAt: base.occurredAt,
    data: { ...base.data, item: summary },
  };
}

/**
 * Whether a stock item is fully depleted (nothing on hand / gauge empty). Exported so the EI-5
 * MQTT state projection derives its out-of-stock count from the exact same rule as the
 * `item.out_of_stock` event (no fork).
 */
export function isStockEmpty(item: ReorderItem): boolean {
  if (item.trackingMode === 'CONSUMABLE_GAUGE') {
    return !item.gauge || item.gauge.percentageRemaining <= 0;
  }
  return item.quantity <= 0;
}

/** The summary event appended when a generation's fan-out is capped. */
function truncationEvent(last: BridgeEvent, omitted: number): BridgeEvent {
  return {
    id: `${last.id}:truncated:${omitted}`,
    type: EVENTS_TRUNCATED_TYPE,
    occurredAt: last.occurredAt,
    data: {
      itemId: last.data.itemId,
      itemName: last.data.itemName,
      action: last.data.action,
      kind: last.data.kind,
      label: `${omitted} more change${omitted === 1 ? '' : 's'} not delivered`,
      detail: `This generation exceeded the fan-out cap; ${omitted} further event${
        omitted === 1 ? ' was' : 's were'
      } omitted.`,
      delta: null,
      quantityDelta: null,
      netValueDelta: null,
      item: null,
    },
  };
}
