/**
 * Pure presentation of a location activity entry (issue #691).
 *
 * The sibling of `history-format.ts`, and deliberately simpler: a location has no quantity and no
 * value, so there is no delta and no tone — only a short action title and the stored note. Keeping
 * it here rather than in the component is what lets the bridge's event model reuse the exact same
 * labels the app shows, so a webhook payload and the History tab never disagree about what a
 * `RE_PARENTED` entry is called.
 *
 * It never touches the DOM, a clock or React, and — being imported by the bridge — must survive
 * Node's **strip-only** loader: no `enum`, no `namespace`, no TS parameter properties.
 */
import type { LocationHistoryAction } from '@/db/repositories/constants';
import type { LocationHistoryEntry } from '@/db/repositories/types';

/** Short, British-English action titles (one per location activity action). */
const ACTION_LABELS: Record<LocationHistoryAction, string> = {
  CREATED: 'Created',
  RENAMED: 'Renamed',
  RE_PARENTED: 'Moved',
  ARCHIVED: 'Archived',
  RESTORED: 'Restored',
  DELETED: 'Deleted',
};

/**
 * The short title for a location activity action. Falls back to a humanised form of the raw enum
 * for a forward-compat action a newer peer may have synced (§7.3) — so the record degrades to
 * readable prose rather than a SCREAMING_SNAKE token or a crash, exactly as the item ledger does.
 */
export function locationHistoryActionLabel(action: string): string {
  return ACTION_LABELS[action as LocationHistoryAction] ?? humanise(action);
}

/** Everything a location activity row needs to render one entry. */
export interface LocationHistoryEntryView {
  /** Short action title, e.g. "Moved". */
  readonly label: string;
  /** The stored human-readable note, or `null` when blank. */
  readonly detail: string | null;
}

export function describeLocationHistoryEntry(entry: LocationHistoryEntry): LocationHistoryEntryView {
  return {
    label: locationHistoryActionLabel(entry.action),
    detail: entry.note?.trim() ? entry.note.trim() : null,
  };
}

/** "SOME_FUTURE_ACTION" → "Some future action". */
function humanise(action: string): string {
  const words = action.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
