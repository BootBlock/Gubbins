import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DIMENSION_UNIT,
  DIMENSION_UNITS,
  formatDimension,
  fromMm,
  normaliseDimensionUnit,
  toMm,
} from './dimensions';

describe('dimension units', () => {
  it('converts each unit to millimetres by its exact factor', () => {
    expect(toMm(1, 'mm')).toBe(1);
    expect(toMm(1, 'cm')).toBe(10);
    expect(toMm(1, 'm')).toBe(1000);
    expect(toMm(1, 'in')).toBeCloseTo(25.4, 6);
    expect(toMm(1, 'ft')).toBeCloseTo(304.8, 6);
  });

  it('round-trips a value through millimetres and back', () => {
    for (const unit of DIMENSION_UNITS) {
      expect(fromMm(toMm(123.4, unit), unit)).toBeCloseTo(123.4, 9);
    }
  });

  it('formats millimetres in the chosen unit with trimmed trailing zeros', () => {
    expect(formatDimension(250, 'mm', 'en-GB')).toBe('250 mm');
    expect(formatDimension(1250, 'm', 'en-GB')).toBe('1.25 m');
    expect(formatDimension(304.8, 'ft', 'en-GB')).toBe('1 ft');
  });

  it('formats a non-finite dimension as the em-dash placeholder', () => {
    expect(formatDimension(Number.NaN, 'mm')).toBe('—');
  });

  it('coerces an unknown persisted unit back to the default', () => {
    expect(normaliseDimensionUnit('cm')).toBe('cm');
    expect(normaliseDimensionUnit('furlong')).toBe(DEFAULT_DIMENSION_UNIT);
    expect(normaliseDimensionUnit('')).toBe(DEFAULT_DIMENSION_UNIT);
  });
});
