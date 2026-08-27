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
import type { HistoryAction, LocationHistoryAction } from '@/db/repositories/constants.ts';
import type { ActivityFeedEntry, Item, LocationHistoryEntry } from '@/db/repositories/types';
import {
  EVENTS_TRUNCATED_TYPE,
  eventTypeForAction,
  eventTypeForLocationAction,
  LOW_STOCK_TYPE,
  OUT_OF_STOCK_TYPE,
  STOCK_ADJUSTED_TYPE,
} from '@/features/events/event-types.ts';
import { locationHistoryActionLabel } from '@/features/inventory/location-history-format.ts';
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
 * The payload of a location activity event (issue #691) — the first event class that is about a
 * *place* rather than an item.
 *
 * Deliberately flat and small. It carries what an automation acts on (which location, what
 * happened) and what a person reads (the label and the note), and nothing else: resolving the
 * location's live state here would mean a read per event for a change that is usually a rename,
 * and `location.removed` has no live state left to read at all.
 *
 * `locationId` is always present, `location.removed` included — the ledger's `location_id` is a
 * historical coordinate with no foreign key, so it survives the location it names. That is the
 * whole point: an automation keyed by location id has to be told *which* one went.
 * `locationName` is the name the place carried when the change happened.
 */
export interface LocationEventData {
  readonly locationId: string;
  readonly locationName: string;
  /** The raw location activity action (e.g. `RE_PARENTED`). */
  readonly action: LocationHistoryAction;
  /** Short British-English action title (e.g. "Moved"). */
  readonly label: string;
  /** The stored human-readable note, or null. */
  readonly detail: string | null;
}

/** A location activity event. Shares the `{ id, type, occurredAt, data }` envelope. */
export type LocationEvent = BridgeEventBase<LocationEventData>;

/**
 * Any event a sink may be handed. Today: a {@link LedgerEvent} (an inventory *change*), a
 * {@link LocationEvent} (a change to a *place*) or a {@link LookupEvent} (the opt-in,
 * read-triggered `lookup.resolved`). Sinks serialise the whole envelope and never introspect
 * `data`, so the union costs them nothing; code that specifically builds or reads ledger payloads
 * should say {@link LedgerEvent}.
 */
export type BridgeEvent = LedgerEvent | LocationEvent | LookupEvent;

/**
 * Is this event about a *place*? A hand-written predicate for the same reason
 * {@link import('./lookup').isLookupEvent} is one: the ledger arm of the union types its `type` as
 * an open `string`, so TypeScript cannot discriminate on it.
 *
 * It tests the **payload**, not the dotted name, and that is deliberate. A `location.` prefix would
 * read more obviously, but it would misclassify the one type that can carry either shape —
 * `events.truncated`, which {@link buildLocationEvents} emits with a location payload when a
 * generation's location changes overflow the fan-out cap. `locationName` is present on every
 * {@link LocationEventData} and on neither of the other two arms, so this narrowing stays sound
 * even for a forward-compat action synced from a newer peer.
 */
export function isLocationEvent(event: BridgeEvent): event is LocationEvent {
  return typeof (event.data as Partial<LocationEventData>).locationName === 'string';
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

// The dotted event-type vocabulary lives in the app (`@/features/events/event-types.ts`) so the
// webhook subscription UI can build its picker from it — `src/` cannot import from `bridge/`, only
// the other way. Re-exported here so every existing bridge call site keeps its import unchanged.
export {
  ACTION_EVENT_TYPE,
  EVENTS_TRUNCATED_TYPE,
  eventTypeForAction,
  eventTypeForLocationAction,
  ITEM_CHANGED_TYPE,
  KNOWN_EVENT_TYPES,
  LOCATION_ACTION_EVENT_TYPE,
  LOCATION_CHANGED_TYPE,
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
 * ledger rows), plus the floor that window rested on. A row is "new" when its id is **absent**
 * from this set and it is not older than that floor — an id-based diff rather
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
  /**
   * The `created_at` of the **oldest row in the previous window**, recorded only when that window
   * came back full. A row older than this floor was already below the window last time, so it can
   * only be in view now because the ledger shrank underneath the cursor, not because anything
   * happened (issue #642). `null` (or absent) means "no floor" — the window did not fill, so it
   * held the whole ledger and every unseen id is genuinely new.
   *
   * "Full" is the page's `hasMore`, which is `rows.length === limit` and so also true for a ledger
   * of exactly `limit` rows, where nothing lies below. That boundary records a floor it does not
   * need. It costs nothing: suppression additionally requires a row to appear *below* the previous
   * bottom, which cannot happen while no row leaves the window.
   *
   * This is the monotonic half of the cursor. The id set alone is bounded by the window, so it
   * slides backwards whenever the window shrinks: a hard delete cascades an item's whole ledger
   * away (`ItemRepository.hardDelete`, through the `ON DELETE CASCADE` on `item_history`), a prune
   * moves rows out from under it, and a restored backup can be shorter than the live ledger. Each pulls
   * previously-unseen old rows into the window, which the id diff alone reads as new and re-emits
   * with their original — months-old — timestamps.
   *
   * It is deliberately *not* a plain high-water mark on the newest row: that would drop the
   * out-of-order synced row the id set exists to catch (§7.3 keeps each row's own `created_at`, so
   * a row from another device can arrive with a timestamp older than one already delivered). The
   * floor sits at the *bottom* of the window instead, which is as low as a boundary can go and
   * still exclude backfill, so all but the oldest of those rows stay inside it and are emitted.
   *
   * Two residues, both stated rather than hidden, and both narrow:
   *
   *  - Rows sharing the floor's exact millisecond are ambiguous, because the feed's tie-break
   *    (`rowid`) is not carried on the entry. They compare as "not older" and are emitted, so a
   *    same-millisecond backfill can still produce a small burst.
   *  - A synced row *older* than the floor is dropped. It can only reach the window at all in a
   *    generation that also removed rows, and at that point it is indistinguishable from the
   *    backfill those removals caused — the ledger carries nothing that separates them.
   */
  readonly backfillFloor?: number | null;
  /**
   * The same thing for the `location_history` scan window (issue #691). Its own set, because the
   * two ledgers are paged independently and a burst in one must not evict the other's baseline.
   * Optional so a cursor persisted by an older build (or a test) still resumes rather than
   * replaying every location change as new — an absent set is read as "no baseline yet".
   */
  readonly locationSeenIds?: readonly string[];
  /** {@link backfillFloor} for the `location_history` window. */
  readonly locationBackfillFloor?: number | null;
}

/** Default page size when scanning the recent ledger for new rows (== the repo page ceiling). */
export const DEFAULT_EVENT_SCAN_LIMIT = 100;
/**
 * Default cap on how many events one **ledger** may fan out per generation. A bulk import writes
 * one snapshot with many new ledger rows; without a cap that would flood every downstream sink.
 * Beyond the cap the batch is truncated and a single {@link EVENTS_TRUNCATED_TYPE} summary event
 * is appended so consumers know changes were omitted.
 *
 * The two ledgers are capped **independently**, so a generation that bursts on both can carry up
 * to two capped batches and two truncation summaries. That is deliberate rather than an oversight:
 * a shared budget would let a bulk item import starve the location events entirely, and "someone
 * deleted the garage" is exactly the change an automation must not lose to an import running at
 * the same moment.
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

/** How the caller describes the page it read, for the parts of the diff a page shape decides. */
export interface DiffOptions {
  /**
   * Did the read fill its page? Pass the page's own `hasMore`, which already accounts for the
   * repository clamping an over-large `limit`. It decides whether this window records a
   * {@link EventCursor.backfillFloor}; a window that did not fill holds the whole ledger and
   * records none. Defaults to `false`, the conservative reading: no floor, so nothing is
   * suppressed.
   */
  readonly windowFull?: boolean;
}

/**
 * Compute the delta of the recent ledger against the previous cursor: the rows whose ids were
 * not in the last scan window **and** are not older than the previous window's floor,
 * **oldest-first** (natural emission order), plus the advanced cursor (this window's ids and
 * floor).
 *
 * `recent` must be the ledger's newest-first page (exactly what `getHistoryFeed` returns).
 * When `previous` is `null` this is the first generation: we establish the baseline from
 * `recent` and emit nothing (`baseline: true`) — no history replay. An empty `recent` (e.g. all
 * history pruned) holds the previous seen-set rather than forgetting it.
 *
 * The floor is what makes a generation that only *removes* rows emit nothing (issue #642) — see
 * {@link EventCursor.backfillFloor} for why an id set alone cannot.
 */
export function diffNewEntries(
  previous: EventCursor | null,
  recent: readonly ActivityFeedEntry[],
  options: DiffOptions = {},
): { newEntries: ActivityFeedEntry[]; cursor: EventCursor; baseline: boolean } {
  const { newRows, seenIds, floor, baseline } = diffNewRows(
    previous?.seenIds ?? null,
    previous?.backfillFloor ?? null,
    recent,
    options.windowFull ?? false,
  );
  // Spread `previous` first so the *other* ledger's baseline survives this diff untouched — a
  // burst of item changes must not make the next generation replay every location change as new.
  return { newEntries: newRows, cursor: { ...previous, seenIds, backfillFloor: floor }, baseline };
}

/**
 * The `location_history` twin of {@link diffNewEntries} (issue #691), against the cursor's own
 * {@link EventCursor.locationSeenIds} window. Returns the advanced set rather than a whole cursor,
 * because the caller composes both halves into one.
 *
 * The cold-start rule applies independently: an existing cursor with no location window yet — the
 * shape an older build persisted — establishes its baseline here and emits nothing, rather than
 * replaying the whole location record as a burst of "new" events. So does the backfill floor: a
 * pruned or restored `location_history` shrinks the window the same way, and the floor is what
 * keeps the rows that slide up into it from being announced as fresh.
 */
export function diffNewLocationEntries(
  previous: EventCursor | null,
  recent: readonly LocationHistoryEntry[],
  options: DiffOptions = {},
): {
  newEntries: LocationHistoryEntry[];
  locationSeenIds: readonly string[];
  locationBackfillFloor: number | null;
  baseline: boolean;
} {
  const { newRows, seenIds, floor, baseline } = diffNewRows(
    previous?.locationSeenIds ?? null,
    previous?.locationBackfillFloor ?? null,
    recent,
    options.windowFull ?? false,
  );
  return { newEntries: newRows, locationSeenIds: seenIds, locationBackfillFloor: floor, baseline };
}

/**
 * The id-set diff both ledgers share: rows in `recent` (newest-first) whose ids were not in
 * `previousSeenIds`, returned **oldest-first**, plus the advanced window.
 *
 * `previousSeenIds === null` means "no baseline yet" — establish one and emit nothing. An empty
 * `recent` (everything pruned) holds the previous window and floor rather than forgetting them,
 * which would otherwise make the next generation re-emit whatever came back.
 *
 * A row older than `previousFloor` is backfill, not news: it sat below the previous window, so it
 * can only be in view now because the ledger shrank underneath the cursor. It is dropped from
 * `newRows` but still enters `seenIds`, so it is settled once and never reconsidered.
 */
function diffNewRows<T extends { readonly id: string; readonly createdAt: number }>(
  previousSeenIds: readonly string[] | null,
  previousFloor: number | null,
  recent: readonly T[],
  windowFull: boolean,
): { newRows: T[]; seenIds: readonly string[]; floor: number | null; baseline: boolean } {
  const seenIds = recent.length > 0 ? recent.map((e) => e.id) : (previousSeenIds ?? []);
  // The next floor is this window's oldest row, and only when the page came back full. A window
  // that did not fill holds the whole ledger and records no floor: nothing can backfill into it,
  // and a floor there would suppress a genuinely older row synced from another device.
  const floor =
    recent.length === 0 ? previousFloor : windowFull ? recent[recent.length - 1]!.createdAt : null;
  if (previousSeenIds === null) return { newRows: [], seenIds, floor, baseline: true };
  const seen = new Set(previousSeenIds);
  const newRows = recent
    .filter((e) => !seen.has(e.id) && (previousFloor === null || e.createdAt >= previousFloor))
    .reverse();
  return { newRows, seenIds, floor, baseline: false };
}

/**
 * Map new location activity entries (oldest-first) to their events, applying the same fan-out cap
 * {@link buildEvents} applies — importing a branch of a hierarchy writes a `CREATED` entry per
 * level, which is exactly the burst the cap exists for. No status events are derived: a place has
 * no stock level to fall below.
 *
 * Truncation is summarised rather than silent, and reuses {@link EVENTS_TRUNCATED_TYPE} rather
 * than minting a location-specific twin of it — a consumer already subscribed to "some events were
 * not sent" should hear about this too. The summary carries a {@link LocationEventData} payload, so
 * `events.truncated` is the one type that can arrive with either shape; {@link isLocationEvent}
 * discriminates on the payload rather than the type name precisely so that stays sound.
 */
export function buildLocationEvents(
  entries: readonly LocationHistoryEntry[],
  options: BuildEventsOptions = {},
): LocationEvent[] {
  const cap = Math.max(1, options.fanOutCap ?? DEFAULT_FAN_OUT_CAP);
  const all: LocationEvent[] = entries.map((entry) => ({
    id: entry.id,
    type: eventTypeForLocationAction(entry.action),
    occurredAt: new Date(entry.createdAt).toISOString(),
    data: {
      locationId: entry.locationId,
      locationName: entry.locationName,
      action: entry.action,
      label: locationHistoryActionLabel(entry.action),
      detail: entry.note?.trim() ? entry.note.trim() : null,
    },
  }));

  if (all.length <= cap) return all;
  const kept = all.slice(0, cap);
  const omitted = all.length - cap;
  const last = kept[kept.length - 1]!;
  kept.push({
    id: `${last.id}:truncated:${omitted}`,
    type: EVENTS_TRUNCATED_TYPE,
    occurredAt: last.occurredAt,
    data: {
      locationId: last.data.locationId,
      locationName: last.data.locationName,
      action: last.data.action,
      label: `${omitted} more location change${omitted === 1 ? '' : 's'} not delivered`,
      detail: `This generation exceeded the fan-out cap; ${omitted} further location event${
        omitted === 1 ? ' was' : 's were'
      } omitted.`,
    },
  });
  return kept;
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
