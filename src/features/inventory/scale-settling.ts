/**
 * Deciding when a live scale reading has *settled* (issue #125) — the honesty half of watching a
 * scale rather than pulling one reading at a time.
 *
 * A live feed makes counting by weight worse before it makes it better. As parts land and the pan
 * oscillates, the derived count jumps around, and a number that silently rewrites itself reads as
 * the app changing its mind. `weigh-count.ts` already refuses to present a fabricated count as
 * fact; this module is the same principle one step earlier — it refuses to present a *moving*
 * reading as a figure at all.
 *
 * The rule is deliberately plain: a reading is **settling** until {@link SETTLE_SAMPLES}
 * consecutive samples agree within a tolerance, and **settled** once they do. A sample that
 * disagrees restarts the window, so tipping a second handful in re-opens the settle rather than
 * averaging the two.
 *
 * **The tolerance is derived from the existing confidence band, not invented beside it.** It is
 * {@link EXACT_DEVIATION_UNITS} of one unit's mass — the very deviation `classifyDeviation` treats
 * as landing on a whole unit. So "the scale has stopped moving" is expressed in the same currency
 * as "the count is exact", and there is one notion of *close enough* in the feature rather than
 * two that can drift apart.
 *
 * Settling and confidence remain **different questions**, and both are reported: settling asks
 * whether the scale has stopped moving, confidence asks whether what it stopped on divides into
 * whole units. A settled reading can still be an `uncertain` count, and should still say so.
 *
 * Side-effect-free (no React, no transport) so the windowing is unit-tested in isolation — see
 * `scale-settling.test.ts`.
 */
import { EXACT_DEVIATION_UNITS } from './weigh-count';

/**
 * How many consecutive agreeing samples make a reading settled.
 *
 * Three, at the bridge's ~250 ms cadence, is about three-quarters of a second of a stable pan —
 * long enough that a scale still swinging cannot pass, short enough that the user is not left
 * waiting on a reading they can already see is steady. Two would settle on the pause between two
 * oscillations; four adds a wait without adding confidence.
 *
 * @internal Exported for unit tests only.
 */
export const SETTLE_SAMPLES = 3;

/**
 * Floor on the settle tolerance, in grams.
 *
 * Five per cent of one unit is meaningless for a very light part — 0.025 g for a 0.5 g screw is
 * finer than any scale a person owns resolves to, so the window would never close and the reading
 * would read as settling for ever. The floor is roughly the resolution of a good bench scale, so a
 * light part settles on the scale's own noise instead of on an unreachable ideal. It only ever
 * *widens* the tolerance, and only where the derived one is narrower than the hardware.
 *
 * @internal Exported for unit tests only.
 */
export const MIN_SETTLE_TOLERANCE_GRAMS = 0.1;

/**
 * The grams two samples may differ by and still count as agreeing, for an item whose unit weighs
 * `unitWeightGrams`. Falls back to the floor for a missing or nonsensical unit weight — a reading
 * still settles there, it simply cannot be turned into a count.
 */
export function settleToleranceGrams(unitWeightGrams: number): number {
  if (!Number.isFinite(unitWeightGrams) || unitWeightGrams <= 0) return MIN_SETTLE_TOLERANCE_GRAMS;
  return Math.max(MIN_SETTLE_TOLERANCE_GRAMS, EXACT_DEVIATION_UNITS * unitWeightGrams);
}

/** The trailing window of samples, and what it currently says. */
export interface SettlingState {
  /**
   * The most recent samples that agree with one another, oldest first, capped at
   * {@link SETTLE_SAMPLES}. Empty before the first sample.
   */
  readonly samples: readonly number[];
  /**
   * The reading to show: the newest sample, or `null` before any has arrived.
   *
   * Deliberately the newest rather than a mean of the window. A mean is steadier, but it is a
   * number no scale ever displayed — and while the user is watching their own scale beside the
   * screen, the two must agree.
   */
  readonly grams: number | null;
  /** Whether the window is full and in agreement, i.e. the scale has stopped moving. */
  readonly settled: boolean;
}

/** The state before any sample has arrived, and the state to return to when a stream drops. */
export const NO_SAMPLES: SettlingState = { samples: [], grams: null, settled: false };

/**
 * Fold one new sample into the window.
 *
 * A sample is compared against **every** sample still in the window, not just the previous one, so
 * the window as a whole describes one stable weight. Disagree with any of them and the window
 * restarts from the new sample alone — tipping a second handful in re-opens the settle rather than
 * being averaged into the first. Agree, and the window extends, dropping its oldest once full.
 *
 * A non-finite sample is ignored outright — it carries no reading, and treating it as a
 * disagreement would reset a window the scale never actually disturbed.
 */
export function pushSample(state: SettlingState, grams: number, toleranceGrams: number): SettlingState {
  if (!Number.isFinite(grams)) return state;

  const agrees = state.samples.every((sample) => Math.abs(sample - grams) <= toleranceGrams);
  const samples = agrees ? [...state.samples, grams].slice(-SETTLE_SAMPLES) : [grams];
  return { samples, grams, settled: samples.length >= SETTLE_SAMPLES };
}
