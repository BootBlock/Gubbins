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
import { isLow, isOutOfStock, type ReorderDefaults } from '@/features/inventory/reorder-policy.ts';
import { LOW_STOCK_GAUGE_PERCENT, LOW_STOCK_QTY_THRESHOLD } from '@/db/repositories/constants.ts';
import type { HistoryAction } from '@/db/repositories/constants.ts';
import type { ActivityFeedEntry, Item } from '@/db/repositories/types';
import {
  EVENTS_TRUNCATED_TYPE,
  eventTypeForAction,
  LOW_STOCK_TYPE,
  OUT_OF_STOCK_TYPE,
  STOCK_ADJUSTED_TYPE,
} from '@/features/events/event-types.ts';
import type { ItemSummaryDto } from '../api/dto.ts';
// Type-only (erased at runtime), so the mutual reference with `lookup.ts` creates no import cycle.
import type { LookupEvent } from './lookup.ts';

/**
 * The envelope every bridge event shares, whatever its `data` carries. `type` is a stable dotted
 * name (`item.created`, `stock.adjusted`, `lookup.resolved`, …); `id` is **deterministic** so
 * every sink can dedupe; `occurredAt` is ISO-8601.
 */
export interface BridgeEventBase<TData> {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: TData;
}

/**
 * A ledger-derived event — the original and overwhelmingly common kind. Its `id` is the
 * `item_history` row's id (or a suffixed derivative), its `occurredAt` is that row's `created_at`,
 * and its `data` reuses the existing `api/dto.ts` item shape.
 */
export type LedgerEvent = BridgeEventBase<BridgeEventData>;

/**
 * Any event a sink may be handed. Today: a {@link LedgerEvent} (an inventory *change*) or a
 * {@link LookupEvent} (the opt-in, read-triggered `lookup.resolved`). Sinks serialise the whole
 * envelope and never introspect `data`, so the union costs them nothing; code that specifically
 * builds or reads ledger payloads should say {@link LedgerEvent}.
 */
export type BridgeEvent = LedgerEvent | LookupEvent;

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

// The dotted event-type vocabulary lives in the app (`@/features/events/event-types.ts`) so the
// webhook subscription UI can build its picker from it — `src/` cannot import from `bridge/`, only
// the other way. Re-exported here so every existing bridge call site keeps its import unchanged.
export {
  ACTION_EVENT_TYPE,
  EVENTS_TRUNCATED_TYPE,
  eventTypeForAction,
  ITEM_CHANGED_TYPE,
  KNOWN_EVENT_TYPES,
  LOW_STOCK_TYPE,
  OUT_OF_STOCK_TYPE,
  STOCK_ADJUSTED_TYPE,
} from '@/features/events/event-types.ts';

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

/** The actions that move stock — the ones that can additionally raise a low/out-of-stock event. */
function isStockAction(action: HistoryAction): boolean {
  return eventTypeForAction(action) === STOCK_ADJUSTED_TYPE;
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
): LedgerEvent[] {
  const cap = Math.max(1, options.fanOutCap ?? DEFAULT_FAN_OUT_CAP);
  const defaults = options.lowStockDefaults ?? DEFAULT_LOW_STOCK;

  const all: LedgerEvent[] = [];
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
function baseEvent({ entry, summary }: ResolvedEntry): LedgerEvent {
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
 * stock item, is neither low nor out of stock, or could not be resolved. The id suffixes the
 * base ledger id so it is deterministic and distinct (a sink can dedupe on it).
 *
 * Out-of-stock is judged **independently** of low-stock: an item that has run to zero raises
 * `item.out_of_stock` whether or not a reorder point was ever configured (running out is a
 * fact, not opt-in). Low-stock stays opt-in — a `item.low_stock` event fires only when the
 * item is below its effective reorder floor. When an item is both, the out-of-stock event
 * takes precedence.
 */
function statusEvent(resolved: ResolvedEntry, defaults: ReorderDefaults): LedgerEvent | null {
  const { entry, item, summary } = resolved;
  if (item === null || !isStockAction(entry.action)) return null;

  const empty = isOutOfStock(item);
  if (!empty && !isLow(item, defaults)) return null;

  const type = empty ? OUT_OF_STOCK_TYPE : LOW_STOCK_TYPE;
  const base = baseEvent(resolved);
  return {
    id: `${entry.id}:${empty ? 'out_of_stock' : 'low_stock'}`,
    type,
    occurredAt: base.occurredAt,
    data: { ...base.data, item: summary },
  };
}

/** The summary event appended when a generation's fan-out is capped. */
function truncationEvent(last: LedgerEvent, omitted: number): LedgerEvent {
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
