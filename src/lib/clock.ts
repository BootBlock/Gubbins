/**
 * clock — the app's single source of "what time is it *for evaluation purposes*".
 *
 * Gubbins is full of date-driven judgements: is this stock dead, is this batch past its
 * best-before, is this booking overdue, is this service due, is this warranty expired. Testing any
 * of them means reaching a date you can't reach — so the hidden lab screen can shift the clock
 * ("pretend today is 24 December"), and this module is where that shift is applied.
 *
 * ## The rule: this shifts *judgements*, never *records*
 *
 * `nowMs()` answers "what should the app consider the current time when deciding whether something
 * is due/expired/idle". It must **not** be used to stamp anything that gets written down —
 * `created_at`, `updated_at`, sync clocks, tombstones, audit entries, "performed at" — because a
 * shifted timestamp written into the database is real, permanent data corruption: it survives the
 * flag being switched off, syncs to other devices, and silently wins or loses last-write-wins
 * resolution against rows it should not have. Persisted timestamps keep calling `Date.now()`
 * directly, and that asymmetry is deliberate.
 *
 * ## Why a module-level offset rather than a store read
 *
 * The offset lives here as a plain number so `nowMs()` stays synchronous, dependency-free and
 * safe to call from anywhere — including the repository layer, which the Node bridge imports and
 * which therefore cannot pull in React or a zustand store. The lab screen's choice is pushed in
 * from the app shell (see {@link import('@/features/lab/useLabClock').useLabClock}); the bridge
 * never sets it, so there the offset is always zero and `nowMs() === Date.now()`.
 */

/** Milliseconds added to the real clock. Zero (the shipped state) means "the actual time". */
let offsetMs = 0;

/** Milliseconds in a day, for callers converting a date choice into an offset. */
export const DAY_MS = 86_400_000;

/**
 * The current time in UNIX-ms for *evaluation*, shifted by any lab offset.
 * Use for "is this due / expired / idle?"; never for a timestamp you are about to store.
 */
export function nowMs(): number {
  return Date.now() + offsetMs;
}

/** {@link nowMs} as a `Date`, for the callers that want calendar fields. */
export function nowDate(): Date {
  return new Date(nowMs());
}

/** The active offset in ms (0 when the clock is real). */
export function clockOffsetMs(): number {
  return offsetMs;
}

/** True while the clock is shifted — used to badge the UI so a shifted app is never mistaken for a real one. */
export function isClockShifted(): boolean {
  return offsetMs !== 0;
}

/**
 * Shift the evaluation clock. Called only by the lab wiring; `0` restores the real clock.
 * Non-finite input is ignored rather than poisoning every date comparison with `NaN`.
 */
export function setClockOffsetMs(ms: number): void {
  offsetMs = Number.isFinite(ms) ? ms : 0;
}

/**
 * The offset that makes "today" land on `isoDate` (`yyyy-mm-dd`), preserving the current
 * time-of-day so only the calendar date moves. Returns 0 for an unparseable date, so a malformed
 * stored value degrades to the real clock instead of throwing on every render.
 */
export function offsetForDate(isoDate: string, from: Date = new Date()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return 0;
  const [, y, m, d] = match;
  const target = new Date(from);
  target.setFullYear(Number(y), Number(m) - 1, Number(d));
  const ms = target.getTime() - from.getTime();
  return Number.isFinite(ms) ? ms : 0;
}
