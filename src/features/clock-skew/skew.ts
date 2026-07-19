/**
 * skew — the pure arithmetic behind the device-clock correction (issue #326).
 *
 * Every "is this expired / overdue / due / idle" judgement in Gubbins resolves to
 * {@link import('@/lib/clock').nowMs}, which used to be the raw system clock. A device whose
 * clock is a week fast therefore marked unexpired stock expired, fired maintenance early and
 * showed loans overdue — silently, because nothing measured the error. This module turns a raw
 * measurement of that error into a correction the app is willing to act on.
 *
 * ## Why a measurement is rounded before it is believed
 *
 * The correction's source is an HTTP `Date` response header (see `features/sync/time-source.ts`);
 * every shipped provider returns `null` from `getServerTime()`, so that header is *always* what
 * the offset is derived from in practice. `Date` carries whole seconds only — so a measurement of
 * "you are 431 ms fast" is not a small skew, it is the quantisation of a clock that agrees. The
 * NTP-style midpoint estimator that produces it also leaves residual asymmetric-latency error on
 * the same scale.
 *
 * Reporting or acting on sub-second precision from a one-second source is therefore false
 * precision. Two guards follow from that:
 *
 *  - a **deadband** below which a measurement is treated as "the clock is fine" rather than as a
 *    tiny correction — otherwise the clock would jitter by a few hundred ms on every measurement,
 *    for no benefit to any judgement the app actually makes; and
 *  - **rounding to the source's own granularity**, so a correction never claims to know the time
 *    more finely than the thing it was measured against.
 *
 * The notice threshold is separate and much larger: a correction worth *applying* is not the same
 * as a skew worth *telling the user about*. Seconds of drift are normal and self-correcting;
 * minutes mean the device clock is genuinely misconfigured and its owner should know.
 *
 * Everything here is pure — no clock, no DOM, no store.
 */

/**
 * The granularity of the correction's source. The HTTP `Date` header is defined in whole
 * seconds, so nothing finer than this is real information.
 */
export const SKEW_SOURCE_GRANULARITY_MS = 1_000;

/**
 * Below this the measurement is indistinguishable from source quantisation plus round-trip
 * asymmetry, so it is read as "no skew" rather than as a correction. Two seconds — one for the
 * `Date` header's own rounding, one for the residual latency error the midpoint estimator leaves.
 */
export const SKEW_DEADBAND_MS = 2 * SKEW_SOURCE_GRANULARITY_MS;

/**
 * At or above this the user is told their device clock is wrong. Five minutes is comfortably
 * past anything drift or a slow link can explain, and is the point where a skew starts moving
 * real judgements (a booking's due time, a service window) rather than just their edges.
 */
export const SKEW_NOTICE_MS = 5 * 60 * 1_000;

/**
 * A sanity ceiling on a correction the app will apply: 365 days. A measurement past this is far
 * likelier to be a broken or hostile `Date` header than a real clock error, and applying it would
 * corrupt every date judgement in the app rather than fix one. Such a reading is discarded — the
 * app falls back to the system clock, which at least fails in a way the user can recognise.
 */
export const SKEW_SANITY_LIMIT_MS = 365 * 24 * 60 * 60 * 1_000;

/**
 * Whether a raw reading is worth believing at all — finite and inside the sanity limit.
 *
 * This is deliberately separate from {@link quantiseSkew}, because "the clocks agree" and "that
 * reading was nonsense" must not collapse to the same answer. Both quantise to `0`, but the first
 * should *clear* a stale correction while the second must leave the existing one alone: a device
 * genuinely a week fast, handed one garbage `Date` header by a broken proxy, would otherwise
 * discard a correct correction and silently go back to judging on its own wrong clock.
 */
export function isPlausibleSkew(rawMs: number): boolean {
  return Number.isFinite(rawMs) && Math.abs(rawMs) <= SKEW_SANITY_LIMIT_MS;
}

/**
 * Turn a raw measured offset into the correction the app will actually apply: `0` inside the
 * deadband or for an implausible reading, otherwise the measurement rounded to the source's
 * granularity.
 *
 * This is the single rule for *both* directions — a fresh measurement and a value rehydrated from
 * localStorage go through it, so a hand-edited or truncated stored value can never apply a
 * correction the measurement path would have refused.
 */
export function quantiseSkew(rawMs: number): number {
  if (!isPlausibleSkew(rawMs)) return 0;
  if (Math.abs(rawMs) < SKEW_DEADBAND_MS) return 0;
  return Math.round(rawMs / SKEW_SOURCE_GRANULARITY_MS) * SKEW_SOURCE_GRANULARITY_MS;
}

/** How long to trust a measurement before taking another (see `clock-skew.ts`). */
export const SKEW_REMEASURE_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Whether a correction measured at `measuredAt` is stale enough to re-measure, given the current
 * raw-clock reading.
 *
 * A *negative* age re-measures too: it means the stored stamp is in the future, which is exactly
 * what happens when the user corrects their system clock backwards. Treating that as "measured
 * recently" would pin the device to a stale correction until the clock caught up — potentially
 * days.
 */
export function shouldRemeasure(measuredAt: number, rawNow: number): boolean {
  if (!Number.isFinite(measuredAt) || measuredAt <= 0) return true;
  const age = rawNow - measuredAt;
  return age < 0 || age >= SKEW_REMEASURE_INTERVAL_MS;
}

/** The coarsest unit worth showing a skew in. Minutes is the finest the notice threshold allows. */
export type SkewUnit = 'minutes' | 'hours' | 'days';

export interface SkewDuration {
  readonly unit: SkewUnit;
  /** Whole units, always positive — {@link skewDirection} carries the sign. */
  readonly count: number;
}

/**
 * Reduce a skew to a whole count of the coarsest sensible unit, for display. Rounded rather than
 * truncated so a 119-minute skew reads as "2 hours" rather than "1 hour".
 */
export function describeSkewDuration(skewMs: number): SkewDuration {
  const minutes = Math.abs(skewMs) / 60_000;
  if (minutes < 60) return { unit: 'minutes', count: Math.max(1, Math.round(minutes)) };
  const hours = minutes / 60;
  if (hours < 24) return { unit: 'hours', count: Math.round(hours) };
  return { unit: 'days', count: Math.round(hours / 24) };
}

/** Whether a (quantised) skew is large enough to be worth warning the user about. */
export function isMaterialSkew(skewMs: number): boolean {
  return Number.isFinite(skewMs) && Math.abs(skewMs) >= SKEW_NOTICE_MS;
}

/**
 * Which way the device clock is wrong. A *positive* skew is the correction added to reach true
 * time, so it means the device reads earlier than it should — a clock running **slow**.
 */
export type SkewDirection = 'fast' | 'slow';

export function skewDirection(skewMs: number): SkewDirection {
  return skewMs < 0 ? 'fast' : 'slow';
}
