import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DIMENSION_UNIT,
  DIMENSION_UNITS,
  DIMENSION_UNIT_OPTIONS,
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
    expect(toMm(1, 'um')).toBeCloseTo(0.001, 9);
    expect(toMm(1, 'thou')).toBeCloseTo(0.0254, 9);
    expect(toMm(1, 'in')).toBeCloseTo(25.4, 6);
    expect(toMm(1, 'ft')).toBeCloseTo(304.8, 6);
    expect(toMm(1, 'yd')).toBeCloseTo(914.4, 6);
  });

  it('keeps the derived units exactly consistent with their parents', () => {
    // A thou is 1/1000 in, a foot 12 in and a yard 3 ft — by definition, not by approximation.
    expect(toMm(1000, 'thou')).toBeCloseTo(toMm(1, 'in'), 9);
    expect(toMm(12, 'in')).toBeCloseTo(toMm(1, 'ft'), 9);
    expect(toMm(3, 'ft')).toBeCloseTo(toMm(1, 'yd'), 9);
  });

  it('offers exactly the supported units in the Settings control', () => {
    expect(DIMENSION_UNIT_OPTIONS.map((o) => o.value).sort()).toEqual([...DIMENSION_UNITS].sort());
    expect(DIMENSION_UNIT_OPTIONS[0]!.value).toBe(DEFAULT_DIMENSION_UNIT);
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
    expect(formatDimension(914.4, 'yd', 'en-GB')).toBe('1 yd');
    // `um` is the ASCII-safe stored code; a reader sees the symbol.
    expect(formatDimension(0.5, 'um', 'en-GB')).toBe('500 µm');
  });

  it('keeps three significant figures for a dimension below one of the chosen unit', () => {
    // A coarse unit under a flat three-decimal cap erased small sizes outright (issue #416).
    expect(formatDimension(0.4, 'yd', 'en-GB')).toBe('0.000437 yd');
    // …while a value of one unit or more keeps every integer digit.
    expect(formatDimension(1234, 'mm', 'en-GB')).toBe('1,234 mm');
  });

  it('formats a non-finite dimension as the em-dash placeholder', () => {
    expect(formatDimension(Number.NaN, 'mm')).toBe('—');
  });

  it('coerces an unknown persisted unit back to the default', () => {
    expect(normaliseDimensionUnit('cm')).toBe('cm');
    expect(normaliseDimensionUnit('yd')).toBe('yd');
    expect(normaliseDimensionUnit('furlong')).toBe(DEFAULT_DIMENSION_UNIT);
    expect(normaliseDimensionUnit('')).toBe(DEFAULT_DIMENSION_UNIT);
  });
});
