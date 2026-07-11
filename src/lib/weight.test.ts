import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHT_UNIT,
  WEIGHT_UNITS,
  formatWeight,
  fromGrams,
  normaliseWeightUnit,
  toGrams,
} from './weight';

describe('weight units', () => {
  it('converts each unit to grams by its exact factor', () => {
    expect(toGrams(1, 'g')).toBe(1);
    expect(toGrams(1, 'kg')).toBe(1000);
    expect(toGrams(1, 'oz')).toBeCloseTo(28.349523125, 6);
    expect(toGrams(1, 'lb')).toBeCloseTo(453.59237, 5);
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
  });

  it('formats a non-finite weight as the em-dash placeholder', () => {
    expect(formatWeight(Number.NaN, 'g')).toBe('—');
  });

  it('coerces an unknown persisted unit back to the default', () => {
    expect(normaliseWeightUnit('kg')).toBe('kg');
    expect(normaliseWeightUnit('stone')).toBe(DEFAULT_WEIGHT_UNIT);
    expect(normaliseWeightUnit('')).toBe(DEFAULT_WEIGHT_UNIT);
  });
});
