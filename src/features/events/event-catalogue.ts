/**
 * The user-facing **event catalogue** (webhooks plan `W2`; see `docs/todo/done/webhooks_2026-07-18.md`).
 *
 * {@link KNOWN_EVENT_TYPES} is the machine vocabulary — a flat list of dotted names. This module is
 * the half a *person* reads: each type paired with a plain-English label, a description of when it
 * actually fires, and a group so the subscription picker can present something better than a wall
 * of identifiers.
 *
 * ## Why this is hand-maintained rather than generated
 *
 * It would be neater to derive the catalogue from `ACTION_EVENT_TYPE`, and an early draft of the
 * plan assumed we could. We cannot: the emitted set comes from **four** places, and one of them is
 * open-ended.
 *
 *   1. `ACTION_EVENT_TYPE` — the ledger-action mapping.
 *   2. The unknown-action fallback (`item.changed`), which is reachable from *any* future action a
 *      newer peer syncs, so the reverse direction ("which actions produce this?") is not derivable.
 *   3. The derived stock-status types, computed in `statusEvent` rather than mapped from an action.
 *   4. The two types declared outside the ledger path entirely — `events.truncated` and
 *      `lookup.resolved`.
 *
 * So a human writes the copy, and {@link KNOWN_EVENT_TYPES} pins the *coverage*: a test asserts the
 * catalogue and the vocabulary describe exactly the same set, in both directions. Adding an event
 * type without describing it fails the build, which is the point — an event nobody can explain is
 * an event nobody can usefully subscribe to.
 *
 * Copy follows the `NAV_DESTINATIONS` precedent: the English string lives here *beside* its
 * `messageKey`, and a drift test asserts the two stay byte-identical. Rendering goes through
 * `t(messageKey)`; the literal is the stable fallback.
 *
 * This module is imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`,
 * no `namespace`, no TS parameter properties.
 */
import type { MessageKey } from '@/features/i18n/messages';
import {
  EVENTS_TRUNCATED_TYPE,
  ITEM_CHANGED_TYPE,
  LOOKUP_RESOLVED_TYPE,
  LOW_STOCK_TYPE,
  OUT_OF_STOCK_TYPE,
  STOCK_ADJUSTED_TYPE,
} from './event-types.ts';

/**
 * How the picker groups the catalogue. Purely presentational — the groups carry no behaviour, and
 * an event's group has no bearing on whether it fires.
 */
export type EventGroup = 'lifecycle' | 'stock' | 'movement' | 'custody' | 'upkeep' | 'system';

/** The order groups appear in the picker: the everyday ones first, plumbing last. */
export const EVENT_GROUP_ORDER: readonly EventGroup[] = [
  'lifecycle',
  'stock',
  'movement',
  'custody',
  'upkeep',
  'system',
];

/** One subscribable event type, described for a human. */
export interface EventCatalogueEntry {
  /** The dotted wire name — what appears in `event_types` and in the delivered payload. */
  readonly type: string;
  /** English label; equals `EN_CATALOG[labelKey]` (drift-tested). */
  readonly label: string;
  readonly labelKey: MessageKey;
  /** English description of *when this fires*; equals `EN_CATALOG[descriptionKey]` (drift-tested). */
  readonly description: string;
  readonly descriptionKey: MessageKey;
  readonly group: EventGroup;
  /**
   * Whether the picker must leave this off by default and mark it as a privacy step beyond the
   * rest. Only `lookup.resolved` sets it: every other event describes a change the user made to
   * their own data, whereas this one publishes *what somebody searched for*. The bridge already
   * treats it as a separate, explicit opt-in rather than something the event stream turns on as a
   * side effect; the app must not quietly undo that by pre-ticking it in a list.
   */
  readonly sensitive?: true;
  /**
   * Whether this type is emitted by the machinery rather than chosen by the user. Shown, because a
   * subscriber genuinely needs to know it can arrive, but never pre-selected.
   */
  readonly diagnostic?: true;
}

/**
 * Every subscribable event type, in picker order. Kept grouped-then-alphabetical by hand so the
 * source reads in the same order the UI renders.
 */
export const EVENT_CATALOGUE: readonly EventCatalogueEntry[] = [
  // --- Lifecycle: the item coming into, or leaving, existence -----------------------
  {
    type: 'item.created',
    label: 'Item created',
    labelKey: 'events.itemCreated.label',
    description: 'A new item was added — including a new variant, or one assembled from a kit.',
    descriptionKey: 'events.itemCreated.description',
    group: 'lifecycle',
  },
  {
    type: 'item.renamed',
    label: 'Item renamed',
    labelKey: 'events.itemRenamed.label',
    description: 'An existing item was given a different name.',
    descriptionKey: 'events.itemRenamed.description',
    group: 'lifecycle',
  },
  {
    type: 'item.removed',
    label: 'Item removed',
    labelKey: 'events.itemRemoved.label',
    description: 'An item was sent to the archive. Its record still exists and can be restored.',
    descriptionKey: 'events.itemRemoved.description',
    group: 'lifecycle',
  },
  {
    type: 'item.restored',
    label: 'Item restored',
    labelKey: 'events.itemRestored.label',
    description: 'An archived item was brought back into the active inventory.',
    descriptionKey: 'events.itemRestored.description',
    group: 'lifecycle',
  },
  {
    type: ITEM_CHANGED_TYPE,
    label: 'Item changed',
    labelKey: 'events.itemChanged.label',
    description:
      'A change with no more specific event of its own — a revaluation, a test record, or a loan renewal. Also covers changes made by a newer version of Gubbins that this one does not recognise.',
    descriptionKey: 'events.itemChanged.description',
    group: 'lifecycle',
  },

  // --- Stock: quantity and gauge movement -------------------------------------------
  {
    type: STOCK_ADJUSTED_TYPE,
    label: 'Stock adjusted',
    labelKey: 'events.stockAdjusted.label',
    description:
      'The amount on hand changed for any reason — counted, consumed, received, sold, written off, or returned to a supplier.',
    descriptionKey: 'events.stockAdjusted.description',
    group: 'stock',
  },
  {
    type: LOW_STOCK_TYPE,
    label: 'Stock ran low',
    labelKey: 'events.lowStock.label',
    description:
      'A stock movement left an item at or below its reorder point. Fires alongside the movement itself, not instead of it.',
    descriptionKey: 'events.lowStock.description',
    group: 'stock',
  },
  {
    type: OUT_OF_STOCK_TYPE,
    label: 'Stock ran out',
    labelKey: 'events.outOfStock.label',
    description:
      'A stock movement left an item with nothing on hand. Sent instead of "Stock ran low", never as well as it.',
    descriptionKey: 'events.outOfStock.description',
    group: 'stock',
  },

  // --- Movement: where the item lives ------------------------------------------------
  {
    type: 'item.moved',
    label: 'Item moved',
    labelKey: 'events.itemMoved.label',
    description: 'An item was moved to a different location, or its location was re-parented.',
    descriptionKey: 'events.itemMoved.description',
    group: 'movement',
  },

  // --- Custody: who has it right now -------------------------------------------------
  {
    type: 'item.checked_out',
    label: 'Item checked out',
    labelKey: 'events.itemCheckedOut.label',
    description: 'An item was lent out or taken by someone.',
    descriptionKey: 'events.itemCheckedOut.description',
    group: 'custody',
  },
  {
    type: 'item.checked_in',
    label: 'Item checked in',
    labelKey: 'events.itemCheckedIn.label',
    description: 'A checked-out item came back.',
    descriptionKey: 'events.itemCheckedIn.description',
    group: 'custody',
  },
  {
    type: 'item.reserved',
    label: 'Item reserved',
    labelKey: 'events.itemReserved.label',
    description: 'An item was set aside for a project or a job.',
    descriptionKey: 'events.itemReserved.description',
    group: 'custody',
  },
  {
    type: 'item.reservation_cleared',
    label: 'Reservation cleared',
    labelKey: 'events.itemReservationCleared.label',
    description: 'A reservation was released and the item is available again.',
    descriptionKey: 'events.itemReservationCleared.description',
    group: 'custody',
  },

  // --- Upkeep: condition, servicing and supplier data --------------------------------
  {
    type: 'item.condition_changed',
    label: 'Condition changed',
    labelKey: 'events.itemConditionChanged.label',
    description: "An item's recorded condition was updated.",
    descriptionKey: 'events.itemConditionChanged.description',
    group: 'upkeep',
  },
  {
    type: 'item.maintenance_logged',
    label: 'Maintenance logged',
    labelKey: 'events.itemMaintenanceLogged.label',
    description: 'A service, repair or inspection was recorded against an item.',
    descriptionKey: 'events.itemMaintenanceLogged.description',
    group: 'upkeep',
  },
  {
    type: 'item.tracking_changed',
    label: 'Tracking mode changed',
    labelKey: 'events.itemTrackingChanged.label',
    description: 'An item switched how it is counted — for example from a simple quantity to a fill gauge.',
    descriptionKey: 'events.itemTrackingChanged.description',
    group: 'upkeep',
  },
  {
    type: 'item.supplier_data_applied',
    label: 'Supplier details applied',
    labelKey: 'events.itemSupplierDataApplied.label',
    description: 'Details fetched from a supplier or product lookup were saved onto an item.',
    descriptionKey: 'events.itemSupplierDataApplied.description',
    group: 'upkeep',
  },

  // --- System: not an inventory change ----------------------------------------------
  {
    type: LOOKUP_RESOLVED_TYPE,
    label: 'Item looked up',
    labelKey: 'events.lookupResolved.label',
    description:
      'Someone asked where an item is and got an answer. This publishes what was searched for, so it is off unless you turn it on — and the bridge needs its own separate setting enabled before it will send.',
    descriptionKey: 'events.lookupResolved.description',
    group: 'system',
    sensitive: true,
  },
  {
    type: EVENTS_TRUNCATED_TYPE,
    label: 'Events were skipped',
    labelKey: 'events.truncated.label',
    description:
      'Too many changes happened at once and some events were not sent. Usually a bulk import — the changes themselves are safe, only the notifications were dropped.',
    descriptionKey: 'events.truncated.description',
    group: 'system',
    diagnostic: true,
  },
];

/** Look up a catalogue entry by its dotted type, or `undefined` when the type is unknown. */
export function eventCatalogueEntry(type: string): EventCatalogueEntry | undefined {
  return EVENT_CATALOGUE.find((entry) => entry.type === type);
}

/**
 * The catalogue grouped for rendering, in {@link EVENT_GROUP_ORDER}. Groups with no entries are
 * omitted, so a future regrouping cannot leave an empty heading behind.
 */
export function eventCatalogueByGroup(): readonly {
  readonly group: EventGroup;
  readonly entries: readonly EventCatalogueEntry[];
}[] {
  return EVENT_GROUP_ORDER.map((group) => ({
    group,
    entries: EVENT_CATALOGUE.filter((entry) => entry.group === group),
  })).filter(({ entries }) => entries.length > 0);
}

/**
 * The types a fresh subscription should start with ticked: everything a user would recognise as
 * "something happened to my stuff". Excludes the sensitive and diagnostic entries — they are
 * offered, never assumed.
 */
export const DEFAULT_SUBSCRIBED_EVENT_TYPES: readonly string[] = EVENT_CATALOGUE.filter(
  (entry) => entry.sensitive === undefined && entry.diagnostic === undefined,
).map((entry) => entry.type);

/**
 * The dotted types this catalogue describes. Coverage against {@link KNOWN_EVENT_TYPES} is asserted
 * in `event-catalogue.test.ts` **in both directions**, so neither list can gain a member the other
 * lacks; this is exported so that assertion reads from one place rather than re-deriving the list.
 */
export const CATALOGUED_EVENT_TYPES: readonly string[] = EVENT_CATALOGUE.map((e) => e.type);
