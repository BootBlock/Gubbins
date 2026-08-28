import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHT_UNIT,
  WEIGHT_UNITS,
  WEIGHT_UNIT_OPTIONS,
  formatWeight,
  fromGrams,
  normaliseWeightUnit,
  toGrams,
} from './weight';

describe('weight units', () => {
  it('converts each unit to grams by its exact factor', () => {
    expect(toGrams(1, 'g')).toBe(1);
    expect(toGrams(1, 'kg')).toBe(1000);
    expect(toGrams(1, 'mg')).toBeCloseTo(0.001, 9);
    expect(toGrams(1, 'oz')).toBeCloseTo(28.349523125, 6);
    expect(toGrams(1, 'lb')).toBeCloseTo(453.59237, 5);
    expect(toGrams(1, 'st')).toBeCloseTo(6350.29318, 5);
    expect(toGrams(1, 'ozt')).toBeCloseTo(31.1034768, 6);
    expect(toGrams(1, 'gr')).toBeCloseTo(0.06479891, 8);
    expect(toGrams(1, 'ct')).toBeCloseTo(0.2, 9);
  });

  it('keeps the derived units exactly consistent with their parents', () => {
    // A stone is 14 lb, a grain 1/7000 lb, and a troy ounce 480 gr — by definition, not by
    // approximation, so these hold to full double precision rather than to a tolerance.
    expect(toGrams(1, 'st')).toBeCloseTo(toGrams(14, 'lb'), 9);
    expect(toGrams(7000, 'gr')).toBeCloseTo(toGrams(1, 'lb'), 9);
    expect(toGrams(1, 'ozt')).toBeCloseTo(toGrams(480, 'gr'), 9);
    expect(toGrams(16, 'oz')).toBeCloseTo(toGrams(1, 'lb'), 9);
  });

  it('offers exactly the supported units in the Settings control', () => {
    expect(WEIGHT_UNIT_OPTIONS.map((o) => o.value).sort()).toEqual([...WEIGHT_UNITS].sort());
    expect(WEIGHT_UNIT_OPTIONS[0]!.value).toBe(DEFAULT_WEIGHT_UNIT);
  });

  it('round-trips a value through grams and back', () => {
    for (const unit of WEIGHT_UNITS) {
      expect(fromGrams(toGrams(123.4, unit), unit)).toBeCloseTo(123.4, 9);
    }
  });

  it('formats grams in the chosen unit with trimmed trailing zeros', () => {
    expect(formatWeight(250, 'g', 'en-GB')).toBe('250 g');
    expect(formatWeight(1250, 'kg', 'en-GB')).toBe('1.25 kg');
    expect(formatWeight(453.59237, 'lb', 'en-GB')).toBe('1 lb');
    expect(formatWeight(1, 'ct', 'en-GB')).toBe('5 ct');
    expect(formatWeight(6350.29318, 'st', 'en-GB')).toBe('1 st');
  });

  it('keeps three significant figures for a weight below one of the chosen unit', () => {
    // A coarse unit under a flat three-decimal cap erased small weights outright (issue #416):
    // half a gram is a real weight, and reading it as `0 st` is worse than reading it small.
    expect(formatWeight(0.5, 'st', 'en-GB')).toBe('0.0000787 st');
    expect(formatWeight(0.4, 'kg', 'en-GB')).toBe('0.0004 kg');
    // …while a value of one unit or more keeps every integer digit rather than being rounded
    // to three figures.
    expect(formatWeight(1_234_000, 'kg', 'en-GB')).toBe('1,234 kg');
  });

  it('formats a non-finite weight as the em-dash placeholder', () => {
    expect(formatWeight(Number.NaN, 'g')).toBe('—');
  });

  it('coerces an unknown persisted unit back to the default', () => {
    expect(normaliseWeightUnit('kg')).toBe('kg');
    expect(normaliseWeightUnit('st')).toBe('st');
    expect(normaliseWeightUnit('stone')).toBe(DEFAULT_WEIGHT_UNIT);
    expect(normaliseWeightUnit('')).toBe(DEFAULT_WEIGHT_UNIT);
  });
});
