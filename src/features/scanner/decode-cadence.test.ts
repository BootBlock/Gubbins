import { describe, it, expect } from 'vitest';
import { initialCadence, nextCadence, DEFAULT_WASM_CADENCE, type CadenceConfig } from './decode-cadence';

/**
 * Adaptive frame-skip cadence for the off-thread WASM scanner decode (spec §6.6, §6.1 battery).
 * Pure state-fold: an empty decode accrues misses and, past a threshold, steps the decode
 * interval up geometrically (capped); a successful decode snaps straight back to the fast base
 * cadence. `useScanner` threads this through its RAF loop so an idle camera idles while a held-up
 * barcode is still picked up promptly.
 */

// A small, easy-to-reason-about config: 100 ms hot, ×2 backoff after 3 misses, capped at 400 ms.
const cfg: CadenceConfig = {
  baseIntervalMs: 100,
  maxIntervalMs: 400,
  missesBeforeBackoff: 3,
  backoffFactor: 2,
};

/** Fold a run of all-miss decodes, returning the final state. */
function missTimes(n: number, config: CadenceConfig) {
  let state = initialCadence(config);
  for (let i = 0; i < n; i++) state = nextCadence(state, false, config);
  return state;
}

describe('decode cadence (spec §6.6 adaptive frame-skip)', () => {
  it('opens at the fast base cadence with no misses', () => {
    expect(initialCadence(cfg)).toEqual({ intervalMs: 100, consecutiveMisses: 0 });
    expect(initialCadence()).toEqual({
      intervalMs: DEFAULT_WASM_CADENCE.baseIntervalMs,
      consecutiveMisses: 0,
    });
  });

  it('keeps the interval but accrues misses below the backoff threshold', () => {
    const after2 = missTimes(2, cfg);
    expect(after2).toEqual({ intervalMs: 100, consecutiveMisses: 2 });
  });

  it('steps the interval up by the backoff factor once the miss threshold is reached', () => {
    const after3 = missTimes(3, cfg);
    // 3 misses → first backoff: 100 × 2 = 200, miss counter resets for the next step.
    expect(after3).toEqual({ intervalMs: 200, consecutiveMisses: 0 });
  });

  it('snaps straight back to the fast base cadence the instant a code is decoded', () => {
    const backedOff = missTimes(6, cfg); // two backoff steps → 400 ms
    expect(backedOff.intervalMs).toBe(400);
    expect(nextCadence(backedOff, true, cfg)).toEqual({ intervalMs: 100, consecutiveMisses: 0 });
  });

  it('caps the interval at maxIntervalMs and never overshoots it', () => {
    // 100 → 200 → 400 → (would be 800) clamped to 400.
    const deep = missTimes(30, cfg);
    expect(deep.intervalMs).toBe(400);
    expect(deep.intervalMs).toBeLessThanOrEqual(cfg.maxIntervalMs);
  });

  it('produces a geometric progression of decode intervals as the camera stays idle', () => {
    const intervals: number[] = [];
    let state = initialCadence(cfg);
    for (let i = 0; i < 9; i++) {
      state = nextCadence(state, false, cfg);
      intervals.push(state.intervalMs);
    }
    // miss 1,2 hold at 100; miss 3 steps to 200; 4,5 hold; 6 steps to 400; 7,8 hold; 9 caps at 400.
    expect(intervals).toEqual([100, 100, 200, 200, 200, 400, 400, 400, 400]);
  });

  it('a mid-backoff hit then resumes backing off from the fast cadence again', () => {
    const backedOff = missTimes(3, cfg); // at 200 ms
    const reset = nextCadence(backedOff, true, cfg); // hit → back to 100
    expect(reset.intervalMs).toBe(100);
    // Misses must re-accrue from scratch before the next step-up.
    const oneMiss = nextCadence(reset, false, cfg);
    expect(oneMiss).toEqual({ intervalMs: 100, consecutiveMisses: 1 });
  });

  it('defaults the config so callers can fold outcomes without passing it', () => {
    const opened = initialCadence();
    const missed = nextCadence(opened, false);
    expect(missed.intervalMs).toBe(DEFAULT_WASM_CADENCE.baseIntervalMs);
    expect(missed.consecutiveMisses).toBe(1);
  });
});
