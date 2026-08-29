/**
 * Activity-kind grouping for the global activity feed (Phase 80).
 *
 * The §4 ledger has far more distinct `HistoryAction`s than fit a chip-per-action
 * filter row. This pure seam folds each action into a handful of semantic **activity
 * kinds** the feed filters by (mirroring the agenda's kind filter). It maps each kind
 * back to the flat list of actions the repository's `getHistoryFeed` `action IN (…)`
 * filter takes, so the screen toggles kinds while the SQL stays correct. No DOM, clock
 * or React dependency — it unit-tests directly.
 */
import { HISTORY_ACTIONS, type HistoryAction } from '@/db/repositories';

/** The semantic activity kinds, in display order. */
export const ACTIVITY_KINDS = ['created', 'stock', 'movement', 'loan', 'lifecycle', 'supplier'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** British-English chip labels, one per kind. */
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  created: 'Created',
  stock: 'Stock',
  movement: 'Moves',
  loan: 'Loans',
  lifecycle: 'Lifecycle',
  supplier: 'Supplier',
};

/**
 * The canonical action → kind mapping. Every {@link HistoryAction} appears exactly
 * once; {@link activityKindForAction} falls back to `'lifecycle'` for any unknown
 * action a newer peer may have synced (§7.3), so the feed degrades gracefully.
 */
const ACTION_KIND: Record<HistoryAction, ActivityKind> = {
  // Things coming into existence.
  CREATED: 'created',
  VARIANT_CREATED: 'created',
  ASSEMBLED: 'created',
  // Quantity / gauge / count movements.
  QUANTITY_CHANGE: 'stock',
  GAUGE_UPDATE: 'stock',
  RECONCILED: 'stock',
  CONSUMED: 'stock',
  RECEIVED: 'stock',
  PROCURED: 'stock',
  // Breaking a kit back down returns its components to stock (Kits v2).
  DISASSEMBLED: 'stock',
  // Physical / hierarchy relocation.
  MOVED: 'movement',
  RE_PARENTED: 'movement',
  // Loans & project reservations.
  CHECKED_OUT: 'loan',
  CHECKED_IN: 'loan',
  LOAN_RENEWED: 'loan',
  RESERVED: 'loan',
  RESERVATION_CLEARED: 'loan',
  // Status / record lifecycle.
  RENAMED: 'lifecycle',
  SOFT_DELETED: 'lifecycle',
  RESTORED: 'lifecycle',
  CONDITION_CHANGED: 'lifecycle',
  TRACKING_CHANGED: 'lifecycle',
  MAINTENANCE_LOGGED: 'lifecycle',
  WRITTEN_OFF: 'lifecycle',
  // A manual current/market revaluation (feature-gap G9) — a record-keeping change.
  REVALUED: 'lifecycle',
  // A per-instance test / calibration / service record (feature-gap G7) — a QA record-keeping event.
  TESTED: 'lifecycle',
  // An edit to the item's notifiable attributes (W10) — record-keeping, not a stock movement.
  ATTRIBUTES_CHANGED: 'lifecycle',
  // The ledger itself was cleared (issue #620) — a record-keeping event about the record.
  HISTORY_CLEARED: 'lifecycle',
  // A sync merge overwrote this device's field values (issue #487) — the same record-keeping
  // change `ATTRIBUTES_CHANGED` covers, arrived at by last-write-wins rather than by an edit.
  MERGE_OVERWRITTEN: 'lifecycle',
  // Two duplicate records folded into one (issue #99) — a change to which record exists, which is
  // what `lifecycle` covers.
  MERGED: 'lifecycle',
  // A variant's parent item changed (issue #99). `lifecycle`, not `movement`: what changed is
  // which record this one hangs beneath, not where it physically is.
  VARIANT_RE_PARENTED: 'lifecycle',
  // Outbound / commercial stock movements.
  SOLD: 'stock',
  // Supplier / external data.
  SCRAPE_APPLIED: 'supplier',
  RETURNED_TO_SUPPLIER: 'supplier',
};

/** The activity kind a history action belongs to (unknown actions → `'lifecycle'`). */
export function activityKindForAction(action: string): ActivityKind {
  return ACTION_KIND[action as HistoryAction] ?? 'lifecycle';
}

/**
 * Flatten the enabled kinds to the history actions the feed filter takes. When **all**
 * kinds are enabled, returns the full action list — the screen treats a full list as
 * "no filter" and passes `undefined`, so the common case never builds an `IN (…)`.
 * Returns an empty array when no kinds are enabled (the feed then shows nothing).
 */
export function actionsForKinds(enabled: ReadonlySet<ActivityKind>): HistoryAction[] {
  return HISTORY_ACTIONS.filter((action) => enabled.has(activityKindForAction(action)));
}
