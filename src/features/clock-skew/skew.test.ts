import { describe, expect, it } from 'vitest';
import {
  SKEW_DEADBAND_MS,
  SKEW_NOTICE_MS,
  SKEW_REMEASURE_INTERVAL_MS,
  SKEW_SANITY_LIMIT_MS,
  describeSkewDuration,
  isMaterialSkew,
  isPlausibleSkew,
  quantiseSkew,
  shouldRemeasure,
  skewDirection,
} from './skew';

describe('quantiseSkew', () => {
  it('treats a sub-deadband measurement as no skew at all', () => {
    // The source is a whole-second HTTP `Date` header, so this is quantisation, not drift.
    expect(quantiseSkew(431)).toBe(0);
    expect(quantiseSkew(-1_999)).toBe(0);
  });

  it('rounds an accepted measurement to the source granularity', () => {
    expect(quantiseSkew(7_400)).toBe(7_000);
    expect(quantiseSkew(7_600)).toBe(8_000);
    expect(quantiseSkew(-7_600)).toBe(-8_000);
  });

  it('accepts a measurement exactly at the deadband', () => {
    expect(quantiseSkew(SKEW_DEADBAND_MS)).toBe(SKEW_DEADBAND_MS);
  });

  it('discards a measurement beyond the sanity limit rather than shifting the app by it', () => {
    expect(quantiseSkew(SKEW_SANITY_LIMIT_MS + 1)).toBe(0);
    expect(quantiseSkew(-(SKEW_SANITY_LIMIT_MS + 1))).toBe(0);
  });

  it('yields no correction for a non-finite measurement', () => {
    expect(quantiseSkew(Number.NaN)).toBe(0);
    expect(quantiseSkew(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('isMaterialSkew', () => {
  it('stays quiet for a skew smaller than the notice threshold', () => {
    expect(isMaterialSkew(60_000)).toBe(false);
  });

  it('warns at or beyond the notice threshold, in either direction', () => {
    expect(isMaterialSkew(SKEW_NOTICE_MS)).toBe(true);
    expect(isMaterialSkew(-SKEW_NOTICE_MS)).toBe(true);
  });

  it('never warns on a non-finite value', () => {
    expect(isMaterialSkew(Number.NaN)).toBe(false);
  });
});

describe('isPlausibleSkew', () => {
  it('separates "the clocks agree" from "that reading was nonsense"', () => {
    // Both quantise to 0, but only the first should be allowed to clear a stored correction.
    expect(isPlausibleSkew(400)).toBe(true);
    expect(isPlausibleSkew(SKEW_SANITY_LIMIT_MS + 1)).toBe(false);
    expect(isPlausibleSkew(Number.NaN)).toBe(false);
  });
});

describe('shouldRemeasure', () => {
  const now = 1_800_000_000_000;

  it('measures when nothing has ever been recorded', () => {
    expect(shouldRemeasure(0, now)).toBe(true);
  });

  it('skips a reading taken within the interval', () => {
    expect(shouldRemeasure(now - 60_000, now)).toBe(false);
  });

  it('measures again once the reading has aged out', () => {
    expect(shouldRemeasure(now - SKEW_REMEASURE_INTERVAL_MS, now)).toBe(true);
  });

  it('measures when the stamp is in the future rather than trusting it', () => {
    // What a user correcting their system clock backwards leaves behind; treating it as recent
    // would pin the device to a stale correction until the clock caught up.
    expect(shouldRemeasure(now + 86_400_000, now)).toBe(true);
  });
});

describe('describeSkewDuration', () => {
  it('reduces to the coarsest sensible unit', () => {
    expect(describeSkewDuration(6 * 60_000)).toEqual({ unit: 'minutes', count: 6 });
    expect(describeSkewDuration(3 * 3_600_000)).toEqual({ unit: 'hours', count: 3 });
    expect(describeSkewDuration(5 * 86_400_000)).toEqual({ unit: 'days', count: 5 });
  });

  it('rounds rather than truncates, so 119 minutes is two hours', () => {
    expect(describeSkewDuration(119 * 60_000)).toEqual({ unit: 'hours', count: 2 });
  });

  it('describes the magnitude regardless of direction', () => {
    expect(describeSkewDuration(-3 * 3_600_000)).toEqual({ unit: 'hours', count: 3 });
  });

  it('never reports a zero count', () => {
    expect(describeSkewDuration(20_000).count).toBe(1);
  });
});

describe('skewDirection', () => {
  it('reads a negative correction as a clock running fast', () => {
    // The correction is *added* to reach true time, so needing to subtract means the device is ahead.
    expect(skewDirection(-3_600_000)).toBe('fast');
  });

  it('reads a positive correction as a clock running slow', () => {
    expect(skewDirection(3_600_000)).toBe('slow');
  });
});
