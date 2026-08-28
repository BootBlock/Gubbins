import { describe, it, expect } from 'vitest';
import { DIMENSION_UNITS } from './dimensions';
import {
  DEFAULT_VOLUME_UNIT,
  VOLUME_UNITS,
  autoVolumeUnit,
  formatVolume,
  fromMm3,
  normaliseVolumeUnit,
  resolveVolumeUnit,
  toMm3,
  volumeFromDimensions,
  volumeSystemForDimensionUnit,
} from './volume';

describe('volume units', () => {
  it('converts each unit to cubic millimetres by its exact factor', () => {
    expect(toMm3(1, 'mm3')).toBe(1);
    expect(toMm3(1, 'cm3')).toBe(1_000);
    expect(toMm3(1, 'l')).toBe(1_000_000);
    expect(toMm3(1, 'm3')).toBe(1_000_000_000);
    // (25.4 mm)³ and (304.8 mm)³ — the exact imperial definitions.
    expect(toMm3(1, 'in3')).toBeCloseTo(16_387.064, 3);
    expect(toMm3(1, 'ft3')).toBeCloseTo(28_316_846.592, 3);
  });

  it('round-trips a value through cubic millimetres and back', () => {
    for (const unit of VOLUME_UNITS) {
      expect(fromMm3(toMm3(123.4, unit), unit)).toBeCloseTo(123.4, 6);
    }
  });

  it('formats cubic millimetres in the chosen unit with trimmed trailing zeros', () => {
    // A 25 × 25 × 20 cm drawer = 12,500,000 mm³ = 12.5 L.
    expect(formatVolume(12_500_000, 'l', 'en-GB')).toBe('12.5 L');
    expect(formatVolume(27_000_000, 'l', 'en-GB')).toBe('27 L');
    expect(formatVolume(1_000, 'cm3', 'en-GB')).toBe('1 cm³');
    expect(formatVolume(1_000_000_000, 'm3', 'en-GB')).toBe('1 m³');
  });

  it('formats a non-finite volume as the em-dash placeholder', () => {
    expect(formatVolume(Number.NaN, 'l')).toBe('—');
    expect(formatVolume(Number.POSITIVE_INFINITY, 'l')).toBe('—');
  });

  it('derives a bounding-box volume only when all three dimensions are present', () => {
    expect(volumeFromDimensions(100, 200, 300)).toBe(6_000_000);
    expect(volumeFromDimensions(100, 200, null)).toBeNull();
    expect(volumeFromDimensions(null, null, null)).toBeNull();
    expect(volumeFromDimensions(100, Number.NaN, 300)).toBeNull();
    expect(volumeFromDimensions(100, -1, 300)).toBeNull();
  });

  it('coerces an unknown persisted unit back to the default, preserving auto', () => {
    expect(normaliseVolumeUnit('l')).toBe('l');
    expect(normaliseVolumeUnit('auto')).toBe('auto');
    expect(normaliseVolumeUnit('gallon')).toBe(DEFAULT_VOLUME_UNIT);
    expect(normaliseVolumeUnit('')).toBe(DEFAULT_VOLUME_UNIT);
  });

  it('maps every length unit onto the metric/imperial family', () => {
    expect(volumeSystemForDimensionUnit('um')).toBe('metric');
    expect(volumeSystemForDimensionUnit('mm')).toBe('metric');
    expect(volumeSystemForDimensionUnit('cm')).toBe('metric');
    expect(volumeSystemForDimensionUnit('m')).toBe('metric');
    expect(volumeSystemForDimensionUnit('thou')).toBe('imperial');
    expect(volumeSystemForDimensionUnit('in')).toBe('imperial');
    expect(volumeSystemForDimensionUnit('ft')).toBe('imperial');
    expect(volumeSystemForDimensionUnit('yd')).toBe('imperial');
    // Every supported length unit is covered above — a new one must be classified here too,
    // or a user picking it silently reads their storage capacity in the wrong family.
    expect(DIMENSION_UNITS).toHaveLength(8);
  });

  describe('autoVolumeUnit', () => {
    it('climbs the metric ladder mm³ → cm³ → L → m³ by human-scaled thresholds', () => {
      expect(autoVolumeUnit(500, 'metric')).toBe('mm3'); // < 1 cm³
      expect(autoVolumeUnit(500_000, 'metric')).toBe('cm3'); // < 1 L
      expect(autoVolumeUnit(27_000_000, 'metric')).toBe('l'); // a drawer
      expect(autoVolumeUnit(2_000_000_000, 'metric')).toBe('m3'); // a bay
    });

    it('uses in³ up to a cubic foot, then ft³, for imperial', () => {
      expect(autoVolumeUnit(27_000_000, 'imperial')).toBe('in3'); // < 1 ft³
      expect(autoVolumeUnit(56_000_000, 'imperial')).toBe('ft3'); // ~2 ft³
    });

    it('falls back to the family small unit for a non-finite value', () => {
      expect(autoVolumeUnit(Number.NaN, 'metric')).toBe('mm3');
      expect(autoVolumeUnit(Number.NaN, 'imperial')).toBe('in3');
    });
  });

  describe('resolveVolumeUnit', () => {
    it('returns a fixed preference unchanged', () => {
      expect(resolveVolumeUnit('l', 27_000_000, 'mm')).toBe('l');
      expect(resolveVolumeUnit('ft3', 500, 'in')).toBe('ft3');
    });

    it('derives an auto preference from the value and the dimension unit', () => {
      expect(resolveVolumeUnit('auto', 27_000_000, 'cm')).toBe('l');
      expect(resolveVolumeUnit('auto', 27_000_000, 'in')).toBe('in3');
    });
  });
});
