import { describe, it, expect } from 'vitest';
import { measurementFormatOptions, trimMeasureNoise } from './measurement-format';

describe('measurementFormatOptions', () => {
  it('caps the fraction digits at one unit or more, keeping every integer digit', () => {
    expect(measurementFormatOptions(1)).toEqual({ maximumFractionDigits: 3 });
    expect(measurementFormatOptions(1_234_567.891_23)).toEqual({ maximumFractionDigits: 3 });
    expect(measurementFormatOptions(-42)).toEqual({ maximumFractionDigits: 3 });
  });

  it('caps the significant figures below one unit, so a small value is not erased', () => {
    expect(measurementFormatOptions(0.999)).toEqual({ maximumSignificantDigits: 3 });
    expect(measurementFormatOptions(0.000_078_7)).toEqual({ maximumSignificantDigits: 3 });
    expect(measurementFormatOptions(-0.5)).toEqual({ maximumSignificantDigits: 3 });
  });

  it('gives a small value three real figures where a fraction cap gave none', () => {
    // Half a gram in stones. The flat three-decimal cap this replaced rendered it as `0`.
    const small = 0.000_078_74;
    expect(new Intl.NumberFormat('en-GB', measurementFormatOptions(small)).format(small)).toBe('0.0000787');
  });
});

describe('trimMeasureNoise', () => {
  it('trims the floating-point noise a conversion leaves behind', () => {
    expect(trimMeasureNoise(1250 / 1000)).toBe('1.25');
    expect(trimMeasureNoise(0.1 + 0.2)).toBe('0.3');
    expect(trimMeasureNoise(250)).toBe('250');
  });

  it('keeps six real figures for a value below one unit, not six decimal places', () => {
    // Half a gram in stones. A flat six-decimal trim gave `0.000079`, which re-saves as
    // 0.5017 g — a 0.3% drift in a field the user never meant to change. Six significant
    // figures holds the round-trip to about one part in a million instead.
    const halfGramInStones = 0.5 / 6350.29318;
    expect(trimMeasureNoise(halfGramInStones)).toBe('0.0000787365');
    expect(Number(trimMeasureNoise(halfGramInStones)) * 6350.29318).toBeCloseTo(0.5, 5);
  });

  it('round-trips a value entered in a coarse unit back to the same canonical figure', () => {
    for (const factor of [6350.29318, 914.4, 31.1034768]) {
      const entered = Number(trimMeasureNoise(0.5 / factor));
      expect(entered * factor).toBeCloseTo(0.5, 5);
    }
  });
});
