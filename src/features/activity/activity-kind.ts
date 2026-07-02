/**
 * Activity-kind grouping for the global activity feed (Phase 80).
 *
 * The §4 ledger has 21 distinct `HistoryAction`s — too many for a chip-per-action
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
  // Physical / hierarchy relocation.
  MOVED: 'movement',
  RE_PARENTED: 'movement',
  // Loans & project reservations.
  CHECKED_OUT: 'loan',
  CHECKED_IN: 'loan',
  RESERVED: 'loan',
  RESERVATION_CLEARED: 'loan',
  // Status / record lifecycle.
  RENAMED: 'lifecycle',
  SOFT_DELETED: 'lifecycle',
  RESTORED: 'lifecycle',
  CONDITION_CHANGED: 'lifecycle',
  TRACKING_CHANGED: 'lifecycle',
  MAINTENANCE_LOGGED: 'lifecycle',
  // Supplier / external data.
  SCRAPE_APPLIED: 'supplier',
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
