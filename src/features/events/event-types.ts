/**
 * The stable dotted **event type** vocabulary — the shared naming seam between the app and the
 * bridge (webhooks plan `W0`; see `docs/todo/webhooks_2026-07-18.md`).
 *
 * These names are a **public contract**: they appear in bridge webhook payloads, the SSE stream,
 * the MQTT event topics and the OpenAPI enum, and third parties filter on them. Treat the set as
 * additive-only — rename nothing, and repurpose nothing.
 *
 * ## Why this lives in `src/` rather than beside the bridge's event model
 *
 * The app needs the vocabulary to build the user-facing webhook subscription picker, but **`src/`
 * cannot import from `bridge/`**: `tsconfig.app.json` is `"include": ["src"]`, and the `@/*` alias
 * is deliberately one-way (bridge → app). So the names live here and the bridge imports them back
 * across that existing seam, exactly as it already does for `activity-kind.ts`, `history-format.ts`
 * and `reorder-policy.ts`. `bridge/src/events/model.ts` re-exports them, so no bridge call site had
 * to change.
 *
 * Deliberately **only the vocabulary** moved. The event *derivation* machinery (`diffNewEntries`,
 * `buildEvents`, the payload shapes) stays on the bridge, because the bridge is the only thing that
 * derives or delivers events — the app configures subscriptions and never sends one.
 *
 * This module is imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`,
 * no `namespace`, no TS parameter properties. Plain `const` objects and derived union types only.
 */
import type { HistoryAction } from '@/db/repositories/constants.ts';

/**
 * The stable dotted event type for each §4 ledger action. Grouped so related actions share a type
 * (e.g. every "coming into existence" action is `item.created`).
 *
 * Exhaustive over {@link HistoryAction} by construction: adding a ledger action without giving it an
 * event type is a **compile error**, which is the point — a new action must be a conscious decision
 * about what, if anything, it publishes.
 */
export const ACTION_EVENT_TYPE: Record<HistoryAction, string> = {
  CREATED: 'item.created',
  VARIANT_CREATED: 'item.created',
  ASSEMBLED: 'item.created',
  RENAMED: 'item.renamed',
  QUANTITY_CHANGE: 'stock.adjusted',
  GAUGE_UPDATE: 'stock.adjusted',
  RECONCILED: 'stock.adjusted',
  CONSUMED: 'stock.adjusted',
  DISASSEMBLED: 'stock.adjusted',
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
  // Outbound disposals & refunds all reduce stock, so they group with stock.adjusted (they can
  // additionally raise a low/out-of-stock event via the derived status types below).
  SOLD: 'stock.adjusted',
  WRITTEN_OFF: 'stock.adjusted',
  RETURNED_TO_SUPPLIER: 'stock.adjusted',
  // Record-keeping lifecycle actions with no stock movement and no dedicated public event type
  // (a manual revaluation, G9; a per-instance test / calibration / service record, G7; a loan
  // renewal, B3, which changes a due date in place). They map to the generic documented
  // `item.changed` — exactly what the unknown-action fallback already produced for them.
  REVALUED: 'item.changed',
  TESTED: 'item.changed',
  LOAN_RENEWED: 'item.changed',
};

/**
 * The generic type an action falls back to. A forward-compat action synced from a newer peer lands
 * here rather than crashing — mirroring the activity-kind graceful degradation. This makes the
 * emitted set **open**, which is why the subscription catalogue cannot simply be derived from
 * {@link ACTION_EVENT_TYPE} in reverse.
 */
export const ITEM_CHANGED_TYPE = 'item.changed';

/**
 * The type every stock-moving action maps to. Named because two places branch on it — the
 * "did this move stock?" test that gates the derived status events below, and the MQTT state
 * projection — and a typo in either would silently stop those events being raised.
 */
export const STOCK_ADJUSTED_TYPE = 'stock.adjusted';

/** Emitted when a stock movement leaves the item low, but not empty. Derived, not action-mapped. */
export const LOW_STOCK_TYPE = 'item.low_stock';

/** Emitted when a stock movement leaves the item fully depleted. Derived, not action-mapped. */
export const OUT_OF_STOCK_TYPE = 'item.out_of_stock';

/** The summary event emitted when a single generation's fan-out is capped. */
export const EVENTS_TRUNCATED_TYPE = 'events.truncated';

/**
 * The one **read-triggered** event type: a "where is X?" lookup resolved. Gated behind its own
 * explicit bridge opt-in, separate from the event stream, because it publishes *what somebody
 * searched for* rather than a change they made.
 */
export const LOOKUP_RESOLVED_TYPE = 'lookup.resolved';

/**
 * The dotted event type for a ledger action (unknown actions → {@link ITEM_CHANGED_TYPE}).
 *
 * The `Object.hasOwn` guard matters: a bare index would resolve inherited `Object.prototype` keys,
 * so `eventTypeForAction('constructor')` would return a *function* rather than falling back. The
 * action normally arrives from a CHECK-constrained column, but this takes a plain `string` and is
 * on the shared contract, so it must not depend on its caller having validated first.
 */
export function eventTypeForAction(action: string): string {
  return Object.hasOwn(ACTION_EVENT_TYPE, action)
    ? ACTION_EVENT_TYPE[action as HistoryAction]
    : ITEM_CHANGED_TYPE;
}

/**
 * Every event type the system can emit, sorted and de-duplicated — the basis for the user-facing
 * subscription picker.
 *
 * Assembled from **four** sources, because no single one is complete: the action map, the
 * unknown-action fallback, the derived stock-status types, and the two types declared outside the
 * ledger path entirely ({@link EVENTS_TRUNCATED_TYPE}, {@link LOOKUP_RESOLVED_TYPE}). A test pins
 * this against what the bridge actually emits.
 */
export const KNOWN_EVENT_TYPES: readonly string[] = [
  ...new Set<string>([
    ...Object.values(ACTION_EVENT_TYPE),
    ITEM_CHANGED_TYPE,
    LOW_STOCK_TYPE,
    OUT_OF_STOCK_TYPE,
    EVENTS_TRUNCATED_TYPE,
    LOOKUP_RESOLVED_TYPE,
  ]),
].sort();
