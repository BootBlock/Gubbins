/**
 * Pure presentation of an Activity Log entry (spec §4 "Activity Log", §4.1.3).
 *
 * The immutable `item_history` ledger stores a small `HistoryAction` enum plus an
 * already-British-English `note` (e.g. "Gauge -45g (now 400g).") and optional
 * quantity / net-value deltas. This module turns one raw {@link ItemHistoryEntry}
 * into the display primitives the Activity Log view renders — a short action title, the
 * detail line, a signed delta badge with a tone, and the per-field before/after values an
 * edit or a sync merge recorded — keeping that logic out of the component so it unit-tests
 * directly (mirrors `describeScrapeError` / `liveRegionAttrs`). It never touches the DOM, a
 * clock or React.
 */
import type { HistoryAction, ItemHistoryEntry } from '@/db/repositories';
import { AUDITED_ITEM_FIELDS } from './audited-item-fields';

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
  DISASSEMBLED: 'Disassembled',
  CHECKED_OUT: 'Checked out',
  CHECKED_IN: 'Checked in',
  LOAN_RENEWED: 'Loan renewed',
  SCRAPE_APPLIED: 'Supplier data applied',
  RECONCILED: 'Reconciled',
  MAINTENANCE_LOGGED: 'Maintenance logged',
  CONDITION_CHANGED: 'Condition changed',
  VARIANT_CREATED: 'Variant created',
  TRACKING_CHANGED: 'Tracking changed',
  SOLD: 'Sold',
  WRITTEN_OFF: 'Written off',
  RETURNED_TO_SUPPLIER: 'Returned to supplier',
  REVALUED: 'Revalued',
  TESTED: 'Test recorded',
  ATTRIBUTES_CHANGED: 'Details changed',
  HISTORY_CLEARED: 'Activity log cleared',
  MERGE_OVERWRITTEN: 'Overwritten by sync',
  MERGED: 'Merged with a duplicate',
  VARIANT_RE_PARENTED: 'Variant re-parented',
};

/**
 * The short title for a history action. Falls back to a humanised form of the raw
 * enum for a forward-compat action a newer peer may have synced (§7.3) — so the log
 * degrades to readable prose rather than a SCREAMING_SNAKE token or a crash.
 */
export function historyActionLabel(action: string): string {
  return ACTION_LABELS[action as HistoryAction] ?? humaniseAction(action);
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

/**
 * A JSON-round-tripped ledger value. `metadata` is stored as JSON, so whatever `SqlValue` the
 * write path recorded arrives back as one of these four.
 */
export type HistoryChangeValue = string | number | boolean | null;

/** One field an edit or a sync merge changed: its name, the value before, and the value after. */
export interface HistoryFieldChange {
  /** The camelCase field name — an {@link AUDITED_ITEM_FIELDS} member, or an unknown peer's. */
  readonly field: string;
  /** The value before the change; `null` means the field was not set. */
  readonly from: HistoryChangeValue;
  /** The value after the change; `null` means the field was cleared. */
  readonly to: HistoryChangeValue;
}

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
  /**
   * The per-field before/after values the entry recorded (issues #144, #487), in
   * {@link AUDITED_ITEM_FIELDS} order, or empty for an entry that carries none. Formatting each
   * value needs the user's locale and currency, so that is the view layer's job
   * (`history-change-format.ts`); this seam only parses and orders them.
   */
  readonly changes: readonly HistoryFieldChange[];
  /**
   * Whether {@link detail} says nothing {@link changes} does not. `ATTRIBUTES_CHANGED` writes its
   * note as "Changed unit cost, barcode." — a list of exactly the fields below it, so a row that
   * showed both would say everything twice. A `MERGE_OVERWRITTEN` note explains *why* the values
   * moved ("Two devices edited this item…"), which nothing else carries, so it is kept.
   */
  readonly noteRepeatsChanges: boolean;
}

/** Registry order, so a multi-field edit lists its fields the same way every time. */
const FIELD_ORDER = new Map(AUDITED_ITEM_FIELDS.map((field, index) => [field, index]));

/** A JSON scalar this module can render, or `null` for anything else (an object, an array). */
function changeValue(raw: unknown): HistoryChangeValue {
  const type = typeof raw;
  return type === 'string' || type === 'number' || type === 'boolean' ? (raw as HistoryChangeValue) : null;
}

/**
 * The `{field, from, to}` records an entry's metadata carries, ordered by {@link FIELD_ORDER}
 * with any field this build does not know appended in the order it was recorded.
 *
 * Written defensively because `item_history` unions across devices (§7.3): the payload may have
 * been produced by a newer peer, or by an older one that never wrote `changes` at all. Anything
 * that is not a record naming a field is dropped rather than rendered as `[object Object]`.
 */
export function parseHistoryChanges(entry: ItemHistoryEntry): readonly HistoryFieldChange[] {
  const raw = entry.metadata?.changes;
  if (!Array.isArray(raw)) return [];
  const parsed: HistoryFieldChange[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { field, from, to } = candidate as Record<string, unknown>;
    if (typeof field !== 'string' || field.length === 0) continue;
    parsed.push({ field, from: changeValue(from), to: changeValue(to) });
  }
  const rank = (change: HistoryFieldChange): number => FIELD_ORDER.get(change.field) ?? FIELD_ORDER.size;
  // A stable sort (guaranteed since ES2019) is what keeps the unknown fields in recorded order.
  return parsed.sort((a, b) => rank(a) - rank(b));
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
  const changes = parseHistoryChanges(entry);
  return {
    label: historyActionLabel(entry.action),
    detail,
    delta: movement === null ? null : signedDelta(movement),
    tone: movement === null ? 'neutral' : movement > 0 ? 'positive' : 'negative',
    changes,
    noteRepeatsChanges: entry.action === 'ATTRIBUTES_CHANGED' && changes.length > 0,
  };
}

/** A signed magnitude using a true minus sign for losses (e.g. `+3`, `−45.5`). */
function signedDelta(n: number): string {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * "SOME_FUTURE_ACTION" → "Some future action" — the graceful degradation both ledgers apply to an
 * action a newer peer synced. Exported so the location record's own formatter shares it: one copy
 * means a later fix to this fallback (an acronym to preserve, an empty token to survive) cannot
 * land on one ledger's view and not the other's.
 */
export function humaniseAction(action: string): string {
  const words = action.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
