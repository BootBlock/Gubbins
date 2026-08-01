/**
 * A write that actually ran out of space, made authoritative over the estimate (issue #504).
 *
 * Every storage degradation state — the banners, the Triage Dashboard, the full-resolution image
 * policy, the Hard Stop — hangs off a tier derived from `navigator.storage.estimate()`. That is a
 * *prediction*, and it is wrong in the one direction that matters:
 *
 *  - Chromium reports a padded, quantised quota by design, so a device that is physically out of
 *    disk can still present ample headroom.
 *  - Under the `opfs-sahpool` fallback the VFS keeps its files under opaque names it manages
 *    itself, and the pool's real occupancy is not what `estimate()` measures.
 *  - An OS-level disk-full is invisible to the Storage API altogether.
 *
 * Meanwhile a write that fails for lack of space is not a prediction at all — it is the thing the
 * whole subsystem exists to handle, and it used to travel no further than a toast. This module is
 * the seam that converts it back into a tier: recognise the failure ({@link
 * isStorageExhaustionError}), and report it to whoever owns the tier.
 *
 * The observer is **registered**, not imported, for the same two reasons as `./write-gate`: the
 * low-level modules that see these failures (the worker RPC driver, the raw OPFS image writes) must
 * not reach into a Zustand store, and the Bridge — which has neither a quota nor those stores —
 * must keep working with no observer installed at all. An unregistered observer is a no-op, so
 * unit tests and the Bridge behave exactly as they did before this seam existed.
 */
import { DbError } from '@/db/errors';
import type { StorageTier } from './tiers';

/**
 * The tier an observed out-of-space failure pins the app to.
 *
 * `locked` — the Hard Stop — rather than merely `critical`, because the observation *is* the
 * condition the Hard Stop was written for: writes are failing, and refusing them up front with an
 * actionable message beats letting each one die deep inside a transaction. Deletions and the
 * Triage recovery workflows deliberately bypass the Hard Stop (see `./write-gate`), so the route
 * out of it stays open — and a successful write, or headroom reappearing, releases it again (see
 * `useStorageStore`).
 */
export const OBSERVED_EXHAUSTION_TIER: StorageTier = 'locked';

/** How deep to follow an error's `cause` chain looking for the underlying quota failure. */
const MAX_CAUSE_DEPTH = 5;

/**
 * SQLite's own wording for a full disk. `DbError` normally carries `SQLITE_FULL` from the numeric
 * result code, but a driver that reports no result code leaves the text as the only evidence —
 * and the text is unambiguous, being a fixed diagnostic string SQLite alone emits.
 */
const SQLITE_FULL_MESSAGE = /database or disk is full/i;

/** True when `value` is a rejection that names the browser's quota error. */
function isQuotaExceeded(value: object): boolean {
  // `DOMException` in every current browser, and the standalone `QuotaExceededError` interface the
  // storage specs are moving to — both identify themselves by `name`, which is what we match on.
  return (value as { name?: unknown }).name === 'QuotaExceededError';
}

/**
 * True when `message` is the browser's quota wording — the last thing left of a
 * `QuotaExceededError` raised *inside the database worker*.
 *
 * That one hop loses everything else this module matches on: the worker normalises the rejection
 * with `DbError.fromUnknown`, which finds no SQLite result code and so settles on `UNKNOWN`, and
 * `toSerialized` carries neither the DOMException's `name` nor its `cause` across the bridge. Only
 * the text survives, and the restore that writes the whole database is exactly the write that
 * reaches it.
 *
 * Both words are required, and only ever on an error, so a message that merely mentions a quota
 * cannot suspend every write on the device. The exact phrasing varies by browser ("The quota has
 * been exceeded.", "Quota exceeded."), which is why this is not a fixed string.
 */
function looksLikeQuotaMessage(message: string): boolean {
  return /quota/i.test(message) && /exceed/i.test(message);
}

/**
 * True when `error` proves a write failed because there was no room for it.
 *
 * Deliberately narrow: this raises the tier to the Hard Stop, so it must recognise genuine
 * exhaustion and nothing else. A `SQLITE_FULL` from the database worker, a `QuotaExceededError`
 * from a raw OPFS write, SQLite's own full-disk wording, or the browser's quota wording left
 * behind by the RPC bridge — each wrapped to any depth, since `DbError.fromUnknown` keeps the
 * original as its `cause`.
 */
export function isStorageExhaustionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (current instanceof DbError && current.code === 'SQLITE_FULL') return true;
    if (isQuotaExceeded(current)) return true;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      (SQLITE_FULL_MESSAGE.test(message) || looksLikeQuotaMessage(message))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** What the app does with an observed storage outcome. Installed once at boot. */
export interface StorageOutcomeObserver {
  /** A write failed for lack of space: the estimate is wrong and the tier must reflect that. */
  readonly onExhausted: () => void;
  /** A write landed: storage is accepting data again, whatever a past failure showed. */
  readonly onWriteSucceeded: () => void;
}

let observer: StorageOutcomeObserver | null = null;

/**
 * Install the production observer (the app does this once at boot). Passing `null` removes it,
 * which is what tests and the Bridge run with — reports are then discarded, exactly as they were
 * before this seam existed.
 */
export function setStorageOutcomeObserver(next: StorageOutcomeObserver | null): void {
  observer = next;
}

/**
 * Report a failed write. Only a genuine out-of-space failure is passed on, so call sites can hand
 * over whatever they caught without classifying it themselves.
 */
export function reportStorageFailure(error: unknown): void {
  if (!isStorageExhaustionError(error)) return;
  observer?.onExhausted();
}

/**
 * Report a write that landed. This is the only evidence that can *disprove* an earlier
 * out-of-space failure — the estimate cannot, which is why the observation outranks it.
 */
export function reportStorageWriteSucceeded(): void {
  observer?.onWriteSucceeded();
}
