/**
 * count-draft — the pure maths behind a **saved count sheet** (issue #587), kept DOM-free,
 * clock-free and React-free in the same "extract the logic out of the glue" style as the
 * sibling `cycle-count.ts` and `audit-session.ts` seams.
 *
 * A stock-take is done away from the desk, one shelf at a time, and it is exactly the
 * workflow that gets interrupted. The walk's cross-location progress already survives a
 * reload ({@link module:audit-session}), but the quantities typed at the location *in hand*
 * lived only in the ephemeral `CycleCountProvider` — so pausing, tapping the backdrop, or a
 * phone reclaiming a backgrounded tab threw them away, and the only way to get them back was
 * to physically recount. This module models the sheet that now survives that.
 *
 * Two properties are deliberate:
 *
 * - **Only real work is stored.** A blank input is not a count, and PRESENT is the default
 *   every serialised instance starts at, so neither is written. A location the auditor merely
 *   looked at therefore has no draft at all — which is what makes "is there a draft?" a
 *   trustworthy signal that there is something to restore.
 * - **Restoring is not pre-filling.** The blind-count rule (§4.4) forbids seeding the sheet
 *   with the *expected* quantities; handing back the numbers the auditor typed themselves is
 *   a different thing entirely. Nothing here ever reads an expected quantity.
 *
 * Drafts are deliberately **not** expired by age: silently dropping a week-old sheet would
 * reintroduce the very "my counts vanished" failure in miniature. Instead {@link CountDraft}
 * carries when it was saved so the resumed sheet can *say* how old it is and offer to start
 * over — the auditor judges whether a count from last Tuesday is still worth trusting.
 */

import { isPlainObject, normaliseArray, normaliseNullableInteger } from '@/lib/persisted-state';
import type { SerialisedPresence } from './cycle-count';

/** How many location sheets are kept before the oldest are evicted. */
export const MAX_COUNT_DRAFTS = 25;

/** One location's saved count sheet — only the work the auditor actually did. */
export interface CountDraft {
  /** Raw counted-quantity input, keyed by count-line key. Blank entries are never stored. */
  readonly counts: Readonly<Record<string, string>>;
  /** Serialised instances flagged MISSING, sorted. PRESENT is the default, so it isn't stored. */
  readonly missing: readonly string[];
  /** When the sheet was last touched (epoch ms), or null if a stored draft carried no usable stamp. */
  readonly savedAt: number | null;
}

/** The minimal count-line shape this seam needs (the session line satisfies it). */
interface KeyedLine {
  readonly key: string;
}

/** The minimal serialised-instance shape this seam needs. */
interface InstanceLine {
  readonly itemId: string;
}

/**
 * Reduce a live count sheet to the draft worth saving, or `null` when the auditor has
 * entered nothing — a sheet of empty boxes is not progress, and storing one would make the
 * "you have unfinished work here" notice fire on a location nobody has touched.
 */
export function draftFrom(
  counts: Readonly<Record<string, string>>,
  presence: Readonly<Record<string, SerialisedPresence>>,
  savedAt: number,
): CountDraft | null {
  const kept = Object.entries(counts).filter(
    (entry): entry is [string, string] => entry[1].trim().length > 0,
  );
  const missing = Object.entries(presence)
    .filter(([, state]) => state === 'MISSING')
    .map(([itemId]) => itemId)
    // Sorted so two sheets holding the same work compare equal regardless of click order.
    .sort();
  if (kept.length === 0 && missing.length === 0) return null;
  return { counts: Object.fromEntries(kept), missing, savedAt };
}

/**
 * True when two drafts hold the same work, ignoring `savedAt`.
 *
 * The store saves on every keystroke, so this is what stops an unchanged sheet rewriting
 * `localStorage` — and, more visibly, what stops a re-seed of an already-restored sheet
 * bumping its timestamp and resetting the age the resume notice reports.
 */
export function sameCountDraft(a: CountDraft | null, b: CountDraft | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.missing.length !== b.missing.length) return false;
  if (a.missing.some((id, i) => id !== b.missing[i])) return false;
  const keys = Object.keys(a.counts);
  if (keys.length !== Object.keys(b.counts).length) return false;
  return keys.every((key) => a.counts[key] === b.counts[key]);
}

/**
 * Keep only the {@link MAX_COUNT_DRAFTS} most recently-saved sheets. Drafts are cleared as
 * each location is authorised or skipped, so in normal use one or two exist at a time; the
 * cap bounds the pathological path (walks started and abandoned over and over) so a store
 * written on every keystroke can't grow until it trips the `localStorage` quota and takes
 * unrelated stores down with it. Ties on `savedAt` keep insertion order, and a draft with no
 * usable stamp sorts oldest.
 */
export function capCountDrafts(
  drafts: Readonly<Record<string, CountDraft>>,
): Readonly<Record<string, CountDraft>> {
  const entries = Object.entries(drafts);
  if (entries.length <= MAX_COUNT_DRAFTS) return drafts;
  return Object.fromEntries(
    entries.sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0)).slice(0, MAX_COUNT_DRAFTS),
  );
}

/**
 * Reconcile a live presence map against the instance list. Instances already judged keep the
 * auditor's flag, ones that have appeared since default to PRESENT, and ones no longer at the
 * location drop out — so a refetch mid-count can't silently un-flag a missing unit.
 *
 * `previous` is returned unchanged when nothing moved. That identity matters: this runs from a
 * state setter re-invoked on every refetch, and returning a fresh-but-equal object each time
 * would re-render forever.
 */
export function reconcilePresence(
  serialised: readonly InstanceLine[],
  previous: Readonly<Record<string, SerialisedPresence>>,
): Readonly<Record<string, SerialisedPresence>> {
  const next: Record<string, SerialisedPresence> = Object.fromEntries(
    serialised.map((line) => [line.itemId, previous[line.itemId] ?? 'PRESENT']),
  );
  const keys = Object.keys(next);
  const unchanged =
    keys.length === Object.keys(previous).length && keys.every((id) => previous[id] === next[id]);
  return unchanged ? previous : next;
}

/** The sheet to seed a location's count with, plus what to tell the auditor about it. */
export interface RestoredCountSheet {
  readonly counts: Readonly<Record<string, string>>;
  readonly presence: Readonly<Record<string, SerialisedPresence>>;
  /** Entries that came back from the draft (counts plus missing flags); 0 = a fresh sheet. */
  readonly restoredEntries: number;
  /** When the restored sheet was saved; null when nothing was restored or the stamp was unusable. */
  readonly savedAt: number | null;
}

/**
 * Build the sheet a location opens with, from its saved draft (if any) and the lines actually
 * there now.
 *
 * Stock moves while an audit is paused, so the draft is reconciled against the current lines
 * rather than trusted wholesale: a count for a lot that has since been consumed, or a missing
 * flag for an instance that has left the location, is dropped instead of resurfacing against a
 * line that no longer exists. Every remaining serialised instance starts PRESENT (§4.4), so a
 * newly-arrived unit is judged rather than inheriting anything.
 */
export function restoreCountSheet(
  draft: CountDraft | null | undefined,
  lines: readonly KeyedLine[],
  serialised: readonly InstanceLine[],
): RestoredCountSheet {
  const lineKeys = new Set(lines.map((line) => line.key));
  const instanceIds = new Set(serialised.map((line) => line.itemId));

  const counts = Object.fromEntries(Object.entries(draft?.counts ?? {}).filter(([key]) => lineKeys.has(key)));
  const missing = new Set((draft?.missing ?? []).filter((itemId) => instanceIds.has(itemId)));
  const presence = Object.fromEntries(
    serialised.map((line) => [line.itemId, missing.has(line.itemId) ? 'MISSING' : 'PRESENT'] as const),
  );

  const restoredEntries = Object.keys(counts).length + missing.size;
  return {
    counts,
    presence,
    restoredEntries,
    savedAt: restoredEntries > 0 ? (draft?.savedAt ?? null) : null,
  };
}

// --- Rehydration -----------------------------------------------------------------

/** Reconcile one persisted sheet; null when nothing usable survives (see the module header). */
function normaliseCountDraft(value: unknown): CountDraft | null {
  if (!isPlainObject(value)) return null;

  // `Object.fromEntries` *defines* each property rather than assigning it, so a key of
  // `__proto__` coming out of untrusted JSON lands as an ordinary own property.
  const counts = Object.fromEntries(
    Object.entries(isPlainObject(value.counts) ? value.counts : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  );
  const missing = [
    ...new Set(
      normaliseArray<string>(
        value.missing,
        [],
        (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
      ),
    ),
  ].sort();

  if (Object.keys(counts).length === 0 && missing.length === 0) return null;
  return { counts, missing, savedAt: normaliseNullableInteger(value.savedAt) };
}

/**
 * Reconcile the whole rehydrated draft map back into a valid shape (see `lib/persisted-state`
 * for why the declared types are a compile-time fiction on this path). Entries that aren't a
 * usable sheet are dropped rather than reaching the count inputs as `undefined`, and the cap
 * is re-applied so a hand-edited or older-release blob can't smuggle an unbounded map in.
 */
export function normaliseCountDrafts(value: unknown): Readonly<Record<string, CountDraft>> {
  if (!isPlainObject(value)) return {};
  const entries: [string, CountDraft][] = [];
  for (const [locationId, raw] of Object.entries(value)) {
    if (locationId === '') continue;
    const draft = normaliseCountDraft(raw);
    if (draft) entries.push([locationId, draft]);
  }
  return capCountDrafts(Object.fromEntries(entries));
}
