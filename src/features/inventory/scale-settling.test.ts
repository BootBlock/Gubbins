import { describe, expect, it } from 'vitest';
import { EXACT_DEVIATION_UNITS } from './weigh-count';
import {
  MIN_SETTLE_TOLERANCE_GRAMS,
  NO_SAMPLES,
  pushSample,
  SETTLE_SAMPLES,
  settleToleranceGrams,
  type SettlingState,
} from './scale-settling';

/** Feed a run of samples through the window, so a case reads as the sequence it describes. */
function feed(samples: readonly number[], toleranceGrams: number): SettlingState {
  return samples.reduce((state, grams) => pushSample(state, grams, toleranceGrams), NO_SAMPLES);
}

describe('settleToleranceGrams', () => {
  // The point of the derivation: "the scale has stopped moving" is measured in the same currency
  // as "the count is exact", so the two notions of close enough cannot drift apart.
  it('is the exact-deviation band expressed in grams of one unit', () => {
    expect(settleToleranceGrams(100)).toBe(EXACT_DEVIATION_UNITS * 100);
  });

  it('never falls below the floor, so a light part can still settle', () => {
    // 5% of a 0.5 g screw is 0.025 g — finer than any scale a person owns resolves to.
    expect(settleToleranceGrams(0.5)).toBe(MIN_SETTLE_TOLERANCE_GRAMS);
  });

  it('falls back to the floor when there is no usable unit weight', () => {
    expect(settleToleranceGrams(0)).toBe(MIN_SETTLE_TOLERANCE_GRAMS);
    expect(settleToleranceGrams(Number.NaN)).toBe(MIN_SETTLE_TOLERANCE_GRAMS);
    expect(settleToleranceGrams(-5)).toBe(MIN_SETTLE_TOLERANCE_GRAMS);
  });
});

describe('pushSample', () => {
  it('is unsettled before any sample has arrived', () => {
    expect(NO_SAMPLES).toEqual({ samples: [], grams: null, settled: false });
  });

  it('stays settling until the window is full', () => {
    const state = feed([100, 100], 1);
    expect(state.settled).toBe(false);
    expect(state.grams).toBe(100);
  });

  it('settles once enough consecutive samples agree', () => {
    const state = feed(
      Array.from({ length: SETTLE_SAMPLES }, () => 100),
      1,
    );
    expect(state.settled).toBe(true);
    expect(state.grams).toBe(100);
  });

  it('settles on samples that differ by no more than the tolerance', () => {
    expect(feed([100, 100.5, 100.9], 1).settled).toBe(true);
  });

  // A pan still swinging must not pass: the window compares against every sample it holds, not
  // just the previous one, so a slow climb never accumulates into a settled reading.
  it('restarts the window when a sample disagrees with any sample in it', () => {
    const state = feed([100, 100.9, 101.9], 1);
    expect(state.settled).toBe(false);
    expect(state.samples).toEqual([101.9]);
  });

  // Tipping a second handful in is a new weight, not a nudge to the old one.
  it('re-opens the settle when the weight jumps', () => {
    const settled = feed([100, 100, 100], 1);
    expect(settled.settled).toBe(true);
    const disturbed = pushSample(settled, 250, 1);
    expect(disturbed.settled).toBe(false);
    expect(disturbed.grams).toBe(250);
  });

  it('stays settled while the reading holds', () => {
    const state = feed([100, 100, 100, 100, 100], 1);
    expect(state.settled).toBe(true);
    expect(state.samples).toHaveLength(SETTLE_SAMPLES);
  });

  // The displayed figure is the newest sample, never a mean: the user is watching their own scale
  // beside the screen, and the two have to agree.
  it('reports the newest sample as the reading', () => {
    expect(feed([100, 100.5], 1).grams).toBe(100.5);
  });

  it('ignores a non-finite sample rather than treating it as a disturbance', () => {
    const settled = feed([100, 100, 100], 1);
    expect(pushSample(settled, Number.NaN, 1)).toBe(settled);
  });

  it('leaves the previous state untouched', () => {
    const first = feed([100, 100], 1);
    pushSample(first, 500, 1);
    expect(first.samples).toEqual([100, 100]);
  });
});
