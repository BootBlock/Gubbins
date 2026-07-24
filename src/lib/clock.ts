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
 * ## Two independent offsets, deliberately not one number
 *
 * `nowMs()` composes two corrections that mean entirely different things:
 *
 *  - **The lab offset** — a *pretend*, deliberately-false time ("act as if today is 24 December"),
 *    set only from the hidden lab screen. It is a testing affordance and the UI badges it as such.
 *  - **The skew correction** — the app's best estimate of the device clock's error against a
 *    trusted server clock, so judgements land on *real* time when the system clock is wrong
 *    (issue #326). A device a week fast would otherwise mark unexpired stock expired, fire
 *    maintenance early and show loans overdue, with nothing to say why.
 *
 * They are kept apart rather than summed into one field because the app has to be able to answer
 * "is this clock pretending?" separately from "is this clock wrong?" — the first is a lab badge,
 * the second a user-facing warning. Collapsing them would make each indistinguishable from the
 * other. Both are applied to judgements and neither is ever written down (see the rule above).
 *
 * ## Why module-level offsets rather than a store read
 *
 * The offsets live here as plain numbers so `nowMs()` stays synchronous, dependency-free and
 * safe to call from anywhere — including the repository layer, which the Node bridge imports and
 * which therefore cannot pull in React or a zustand store. The lab screen's choice is pushed in
 * from the app shell (see {@link import('@/features/lab/lab-clock').startLabClock}) and the
 * measured skew from {@link import('@/features/clock-skew/clock-skew').startClockSkew}; the
 * bridge sets neither, so there both are zero and `nowMs() === Date.now()`.
 */

/** Milliseconds added to the real clock by the lab. Zero (the shipped state) means "the actual time". */
let offsetMs = 0;

/**
 * Milliseconds added to correct a *wrong* device clock, from the measured server offset.
 * Zero means "the system clock is trusted" — either it is accurate or nothing has measured it.
 */
let skewMs = 0;

/** Milliseconds in a day, for callers converting a date choice into an offset. */
export const DAY_MS = 86_400_000;

/**
 * The current time in UNIX-ms for *evaluation*, corrected for a wrong device clock and then
 * shifted by any lab offset.
 * Use for "is this due / expired / idle?"; never for a timestamp you are about to store.
 */
export function nowMs(): number {
  return Date.now() + skewMs + offsetMs;
}

/** {@link nowMs} as a `Date`, for the callers that want calendar fields. */
export function nowDate(): Date {
  return new Date(nowMs());
}

/**
 * The active offset in ms (0 when the clock is real).
 *
 * @internal Exported for unit tests only.
 */
export function clockOffsetMs(): number {
  return offsetMs;
}

/**
 * True while the clock is *pretending* — used to badge the UI so a shifted app is never mistaken
 * for a real one. Deliberately blind to {@link clockSkewMs}: a corrected-but-honest clock is not
 * a lab clock, and conflating the two would badge every skewed device as being in a test mode.
 *
 * @internal Exported for unit tests only.
 */
export function isClockShifted(): boolean {
  return offsetMs !== 0;
}

/** The active skew correction in ms (0 when the device clock is trusted or unmeasured). */
export function clockSkewMs(): number {
  return skewMs;
}

/**
 * Apply the measured device-clock skew correction, in ms to *add* to `Date.now()` to reach true
 * time (issue #326). Non-finite input is ignored rather than poisoning every date comparison
 * with `NaN` — the same guard {@link setClockOffsetMs} makes, and for the same reason.
 *
 * Callers pass an already-quantised value: the correction is only as precise as its source, and
 * `features/clock-skew/skew.ts` owns that rounding so this module stays a plain accumulator.
 */
export function setClockSkewMs(ms: number): void {
  skewMs = Number.isFinite(ms) ? ms : 0;
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
 *
 * The calendar date is shifted in **UTC** (`setUTCFullYear`), not local time. This is the frame
 * the lab clock exists to probe: the date-driven judgements it lets you test — warranty expiry,
 * best-before, acquisition age — compare {@link nowMs} against **UTC-midnight** values (date-only
 * TEXT columns are read back as UTC, per `src/lib/date-input.ts`). Shifting with local
 * `setFullYear` moved the *local* calendar day instead, so east of UTC "pretend today is 24
 * December" landed the app's UTC day on the 23rd — leaving the one tool built to test these
 * boundaries wrong at exactly the boundaries (#327).
 *
 * `from` defaults to the **skew-corrected** clock, not the raw system one, because the result is
 * added on top of the skew correction inside {@link nowMs}. Measuring from the raw clock would
 * double-count the device's error: on a machine running three days fast, picking 24 December
 * produced an offset relative to the wrong "today", and the app then believed it was the 21st
 * while the lab badge insisted it was the 24th (#326).
 */
export function offsetForDate(isoDate: string, from: Date = new Date(Date.now() + skewMs)): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return 0;
  const [, y, m, d] = match;
  const target = new Date(from);
  target.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  const ms = target.getTime() - from.getTime();
  return Number.isFinite(ms) ? ms : 0;
}
