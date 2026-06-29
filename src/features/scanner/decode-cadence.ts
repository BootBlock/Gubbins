/**
 * Adaptive frame-skip cadence for the off-thread WASM scanner decode (spec §6.6, §6.1 battery).
 *
 * The native Barcode Detection API runs per animation frame (it offloads to the device's
 * hardware, so it is effectively free). The Phase-31 worker zxing decode (the Firefox/Safari
 * fallback) is off the main thread but still costs real CPU *per frame*: decoding every ~120 ms
 * regardless of what is in view needlessly drains the battery of a low-end device that is simply
 * pointed at an empty bench.
 *
 * This pure helper makes the WASM decode interval *adaptive*: once a run of frames has found
 * nothing it backs the interval off geometrically (capped), and it snaps straight back to the
 * fast base cadence the instant a code is decoded — so a barcode that is actually held up is
 * still picked up promptly, while an idle camera quietly idles. It is a deterministic state-fold
 * with no clock or DOM, so `useScanner` can thread it through its RAF loop and it is fully
 * unit-testable; the native engine ignores it entirely (it has no per-frame cost to amortise).
 */

export interface CadenceConfig {
  /** The fast cadence used while actively finding codes (and at stream start), in ms. */
  readonly baseIntervalMs: number;
  /** The slowest cadence the idle backoff will reach, in ms (never exceeded). */
  readonly maxIntervalMs: number;
  /** Consecutive empty decodes before the interval steps up by one backoff factor. */
  readonly missesBeforeBackoff: number;
  /** Multiplier applied to the interval at each backoff step. */
  readonly backoffFactor: number;
}

/**
 * The default WASM-path cadence: 120 ms while hot (the Phase-31 fixed throttle), doubling toward
 * a ~600 ms idle floor after roughly a second of finding nothing — ~8 decodes/s when a code is
 * near, easing to ~1.7/s when the camera sees nothing, with a ≤600 ms latency to re-acquire.
 */
export const DEFAULT_WASM_CADENCE: CadenceConfig = {
  baseIntervalMs: 120,
  maxIntervalMs: 600,
  missesBeforeBackoff: 8,
  backoffFactor: 2,
};

export interface CadenceState {
  /** The minimum ms the RAF loop should wait before the next decode attempt. */
  readonly intervalMs: number;
  /** Consecutive decode attempts that have found nothing since the last step-up or hit. */
  readonly consecutiveMisses: number;
}

/** The opening state: fast cadence, no misses yet. */
export function initialCadence(config: CadenceConfig = DEFAULT_WASM_CADENCE): CadenceState {
  return { intervalMs: config.baseIntervalMs, consecutiveMisses: 0 };
}

/**
 * Fold one decode outcome into the cadence. A hit (`didDecode`) resets to the fast base
 * cadence; a miss accrues, and once `missesBeforeBackoff` misses pile up the interval steps up
 * by `backoffFactor` (clamped to `maxIntervalMs`) and the miss counter resets for the next step.
 */
export function nextCadence(
  state: CadenceState,
  didDecode: boolean,
  config: CadenceConfig = DEFAULT_WASM_CADENCE,
): CadenceState {
  if (didDecode) return initialCadence(config);
  const misses = state.consecutiveMisses + 1;
  if (misses < config.missesBeforeBackoff) {
    return { intervalMs: state.intervalMs, consecutiveMisses: misses };
  }
  const stepped = Math.min(state.intervalMs * config.backoffFactor, config.maxIntervalMs);
  return { intervalMs: stepped, consecutiveMisses: 0 };
}
