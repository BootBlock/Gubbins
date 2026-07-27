/**
 * "This device has held a database before" — the marker that lets boot tell a first run from a
 * browser storage wipe (issue #505).
 *
 * The database lives in OPFS, and OPFS is the browser's to reclaim: an eviction under storage
 * pressure, iOS's seven-day cap on an uninstalled web app, a "clear site data" that took storage
 * but not `localStorage`, an interrupted purge. In every one of those the next boot opens SQLite
 * with the create-if-absent flag, builds a clean v1, and — because nothing on disk distinguishes
 * "no database yet" from "the database is gone" — presents a fully-configured app with an empty
 * inventory and says nothing. The likeliest reaction is to assume Gubbins lost the data and start
 * re-typing it, which turns a clean restore into a merge.
 *
 * So a small record is kept **outside** the database, in `localStorage`, and consulted before the
 * app is handed over: a boot that had to *create* the database while this marker exists is a boot
 * that lost one. That is deliberately a partial answer — an eviction that takes the whole origin
 * takes this with it, and nothing can then tell the difference — so the honest scope is "detect
 * what is detectable, and stay quiet otherwise" rather than a guess dressed as a fact.
 *
 * The decision is a pure function ({@link evaluateDbPresence}) so every case is unit-tested
 * without a browser; only the read/write helpers touch `localStorage`, and each survives it being
 * unavailable (private mode, blocked site data) by degrading to "no marker".
 *
 * Sits beside {@link import('./db-storage')} — the other main-thread module that answers "what is
 * actually on this device" — and like it deliberately imports nothing heavy: the boot gate and the
 * crash screen both reach for it, and neither may pull the SQLite WASM glue in for the sake of a
 * marker (issue #165).
 *
 * **Timestamps here are records, not judgements**, so they are stamped with `Date.now()` and never
 * `nowMs()` — see `lib/clock.ts`. A lab clock offset written into this marker would outlive the
 * flag and misdate a real loss notice.
 */
import { DB_PRESENCE_KEY } from '@/lib/storage-keys';

/** What this device last knew about its own database. Persisted as JSON under {@link DB_PRESENCE_KEY}. */
export interface DbPresenceMarker {
  /** Schema of this record; anything else is treated as an unreadable marker (see below). */
  readonly version: 1;
  /**
   * When this device last completed a boot, in UNIX-ms. `null` where a marker was present but
   * could not be read — its mere existence still proves a database was here, which is the fact
   * that matters, so it is kept rather than discarded for want of a date.
   */
  readonly lastSeenAt: number | null;
  /** How many items the last boot found, or `null` when it never got as far as counting. */
  readonly lastKnownItems: number | null;
  /** A detected loss the user has not yet been shown, or `null`. See {@link DbLossRecord}. */
  readonly unacknowledgedLoss: DbLossRecord | null;
}

/**
 * One detected disappearance, held until the user has actually been told about it.
 *
 * Kept in the marker rather than reported once and forgotten because the boot that *detects* the
 * loss is also the boot that re-establishes the marker: without this, closing the tab on the
 * notice would leave every later boot looking like an ordinary returning device, and the user
 * back where they started — an empty inventory with no explanation.
 */
export interface DbLossRecord {
  /** When the loss was noticed, in UNIX-ms. */
  readonly detectedAt: number;
  /** When the device last had the database, in UNIX-ms, or `null` when that was not recorded. */
  readonly lastSeenAt: number | null;
  /** How many items it held then, or `null` when that was not recorded. */
  readonly lastKnownItems: number | null;
}

/** What this boot turned out to be. */
export type DbPresenceVerdict =
  /** No marker and a database had to be created: a genuine first run, or an origin wiped whole. */
  | { readonly kind: 'first-run' }
  /** The database was already there — the ordinary case. */
  | { readonly kind: 'returning' }
  /** A database was here and is gone; the user has not been told yet. */
  | { readonly kind: 'lost'; readonly loss: DbLossRecord };

/** {@link evaluateDbPresence}'s answer: what happened, and the marker to persist for next time. */
export interface DbPresenceOutcome {
  readonly verdict: DbPresenceVerdict;
  /** The marker this boot should write. Always persist it, whatever the verdict. */
  readonly marker: DbPresenceMarker;
}

/**
 * Decide what this boot was, and what to record for the next one. Pure.
 *
 * `freshlyCreated` is whether the boot had to build the schema from nothing (`migration.from === 0`)
 * — the one signal that separates "opened what was there" from "made a new one".
 */
export function evaluateDbPresence(
  previous: DbPresenceMarker | null,
  freshlyCreated: boolean,
  now: number,
): DbPresenceOutcome {
  const verdict = classify(previous, freshlyCreated, now);
  return {
    verdict,
    marker: {
      version: 1,
      lastSeenAt: now,
      // A database that was just created holds nothing, so any earlier figure is now a lie about
      // the current one. `recordKnownItemCount` fills it in once this boot has counted.
      lastKnownItems: freshlyCreated ? null : (previous?.lastKnownItems ?? null),
      unacknowledgedLoss: verdict.kind === 'lost' ? verdict.loss : null,
    },
  };
}

function classify(
  previous: DbPresenceMarker | null,
  freshlyCreated: boolean,
  now: number,
): DbPresenceVerdict {
  if (freshlyCreated) {
    if (!previous) return { kind: 'first-run' };
    // A second wipe before the first was acknowledged: keep the *older* record. It is the one that
    // describes when this device last actually held the user's data — the newer one would only
    // report the empty database the previous loss left behind.
    return {
      kind: 'lost',
      loss: previous.unacknowledgedLoss ?? {
        detectedAt: now,
        lastSeenAt: previous.lastSeenAt,
        lastKnownItems: previous.lastKnownItems,
      },
    };
  }
  if (previous?.unacknowledgedLoss) return { kind: 'lost', loss: previous.unacknowledgedLoss };
  return { kind: 'returning' };
}

/**
 * The marker this device holds, or `null` when it has none.
 *
 * A stored value that cannot be parsed is **not** treated as absent: the key existing at all is
 * the proof that a database was here, and discarding it would turn a detectable loss into a
 * silent one. Such a marker simply carries no date or count.
 */
export function readDbPresence(): DbPresenceMarker | null {
  const raw = readRaw();
  if (raw === null) return null;
  return parseMarker(raw) ?? UNREADABLE_MARKER;
}

/** Persist `marker`, best-effort — a device that cannot write it just stays undetectable. */
export function writeDbPresence(marker: DbPresenceMarker): void {
  try {
    localStorage.setItem(DB_PRESENCE_KEY, JSON.stringify(marker));
  } catch {
    // localStorage unavailable or full — nothing here is worth failing a boot over.
  }
}

/**
 * Forget that this device ever had a database.
 *
 * Called at the *start* of the Safe-Mode hard reset, before the database files go: a deliberate
 * purge is not a loss, and one interrupted half-way must not come back as "your data was cleared
 * by the browser".
 */
export function clearDbPresence(): void {
  try {
    localStorage.removeItem(DB_PRESENCE_KEY);
  } catch {
    // localStorage unavailable — there is nothing recorded to clear either.
  }
}

/** Record that the user has been shown the loss notice, so later boots stop raising it. */
export function acknowledgeDbLoss(): void {
  const marker = readDbPresence();
  if (!marker?.unacknowledgedLoss) return;
  writeDbPresence({ ...marker, unacknowledgedLoss: null });
}

/**
 * Record how many items this device holds, for the notice a *later* boot may have to show.
 *
 * Deliberately separate from {@link evaluateDbPresence}: counting needs the database, and no boot
 * should wait on a figure that only matters if the database later disappears.
 */
export function recordKnownItemCount(count: number): void {
  const marker = readDbPresence();
  if (!marker) return;
  writeDbPresence({ ...marker, lastKnownItems: count });
}

/** What a present-but-unreadable marker degrades to: "a database was here", and nothing more. */
const UNREADABLE_MARKER: DbPresenceMarker = {
  version: 1,
  lastSeenAt: null,
  lastKnownItems: null,
  unacknowledgedLoss: null,
};

function readRaw(): string | null {
  try {
    return localStorage.getItem(DB_PRESENCE_KEY);
  } catch {
    return null;
  }
}

/**
 * Parse a stored marker, or `null` when the value is not one this build understands (corrupt
 * JSON, a different shape, or a `version` written by a build this one has been rolled back from).
 *
 * @internal Exported for unit tests only.
 */
export function parseMarker(raw: string): DbPresenceMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  return {
    version: 1,
    lastSeenAt: finiteOrNull(record.lastSeenAt),
    lastKnownItems: finiteOrNull(record.lastKnownItems),
    unacknowledgedLoss: parseLoss(record.unacknowledgedLoss),
  };
}

function parseLoss(value: unknown): DbLossRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const detectedAt = finiteOrNull(record.detectedAt);
  // Without *when* it was detected there is no loss record to speak of — the acknowledgement it
  // carries would then have nothing to date it by.
  if (detectedAt === null) return null;
  return {
    detectedAt,
    lastSeenAt: finiteOrNull(record.lastSeenAt),
    lastKnownItems: finiteOrNull(record.lastKnownItems),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
