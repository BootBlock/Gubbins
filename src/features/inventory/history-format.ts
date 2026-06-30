/**
 * Pure presentation of an Activity Log entry (spec §4 "Activity Log", §4.1.3).
 *
 * The immutable `item_history` ledger stores a small `HistoryAction` enum plus an
 * already-British-English `note` (e.g. "Gauge -45g (now 400g).") and optional
 * quantity / net-value deltas. This module turns one raw {@link ItemHistoryEntry}
 * into the three display primitives the Activity Log view renders — a short action
 * title, the detail line and a signed delta badge with a tone — keeping that logic
 * out of the component so it unit-tests directly (mirrors `describeScrapeError` /
 * `liveRegionAttrs`). It never touches the DOM, a clock or React.
 */
import type { HistoryAction, ItemHistoryEntry } from '@/db/repositories';

/** Short, British-English action titles for the Activity Log (one per §4 action). */
const ACTION_LABELS: Record<HistoryAction, string> = {
  CREATED: 'Created',
  RENAMED: 'Renamed',
  QUANTITY_CHANGE: 'Quantity changed',
  GAUGE_UPDATE: 'Gauge updated',
  MOVED: 'Moved',
  SOFT_DELETED: 'Removed from inventory',
  RESTORED: 'Restored',
  RE_PARENTED: 'Re-parented',
  RESERVED: 'Reserved',
  RESERVATION_CLEARED: 'Reservation cleared',
  PROCURED: 'Ordered',
  RECEIVED: 'Received',
  CONSUMED: 'Consumed',
  ASSEMBLED: 'Assembled',
  CHECKED_OUT: 'Checked out',
  CHECKED_IN: 'Checked in',
  SCRAPE_APPLIED: 'Supplier data applied',
  RECONCILED: 'Reconciled',
  MAINTENANCE_LOGGED: 'Maintenance logged',
  CONDITION_CHANGED: 'Condition changed',
  VARIANT_CREATED: 'Variant created',
};

/**
 * The short title for a history action. Falls back to a humanised form of the raw
 * enum for a forward-compat action a newer peer may have synced (§7.3) — so the log
 * degrades to readable prose rather than a SCREAMING_SNAKE token or a crash.
 */
export function historyActionLabel(action: string): string {
  return ACTION_LABELS[action as HistoryAction] ?? humanise(action);
}

export type HistoryTone = 'positive' | 'negative' | 'neutral';

/**
 * Design-token badge classes for a non-neutral delta tone — shared by the per-item
 * Activity Log (Phase 52) and the global activity feed (Phase 80) so the styling never
 * drifts between the two views. A gain reads as success; a loss is deliberately neutral
 * (a depletion isn't an error) rather than destructive-red.
 */
export const HISTORY_TONE_BADGE: Record<Exclude<HistoryTone, 'neutral'>, string> = {
  positive: 'bg-success/15 text-success',
  negative: 'bg-secondary text-muted-foreground',
};

/** Everything the Activity Log row needs to render one ledger entry. */
export interface HistoryEntryView {
  /** Short action title, e.g. "Quantity changed". */
  readonly label: string;
  /** The stored human-readable note, or `null` when blank. */
  readonly detail: string | null;
  /** A signed delta badge ("+3" / "−45.5"), or `null` when there is no movement. */
  readonly delta: string | null;
  /** Colour cue for the delta: a gain, a loss, or neither. */
  readonly tone: HistoryTone;
}

export function describeHistoryEntry(entry: ItemHistoryEntry): HistoryEntryView {
  // Prefer a discrete quantity delta; fall back to the continuous gauge delta. A
  // zero or absent delta shows no badge (e.g. a Move or a Rename).
  const movement =
    entry.quantityDelta != null && entry.quantityDelta !== 0
      ? entry.quantityDelta
      : entry.netValueDelta != null && entry.netValueDelta !== 0
        ? entry.netValueDelta
        : null;
  const detail = entry.note?.trim() ? entry.note.trim() : null;
  return {
    label: historyActionLabel(entry.action),
    detail,
    delta: movement === null ? null : signedDelta(movement),
    tone: movement === null ? 'neutral' : movement > 0 ? 'positive' : 'negative',
  };
}

/** A signed magnitude using a true minus sign for losses (e.g. `+3`, `−45.5`). */
function signedDelta(n: number): string {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/** "SOME_FUTURE_ACTION" → "Some future action". */
function humanise(action: string): string {
  const words = action.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
