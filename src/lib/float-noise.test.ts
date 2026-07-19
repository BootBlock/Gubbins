import { describe, expect, it } from 'vitest';
import { stripFloatNoise } from './float-noise';

describe('stripFloatNoise', () => {
  it('drops the representation noise on decimal arithmetic', () => {
    expect(stripFloatNoise(0.1 + 0.2)).toBe(0.3);
    expect(stripFloatNoise(0.1 * 3)).toBe(0.3);
    expect(String(stripFloatNoise(0.1 * 3))).toBe('0.3');
    expect(String(stripFloatNoise(1.005 * 3))).toBe('3.015');
    expect(String(stripFloatNoise(0.07 * 100))).toBe('7');
  });

  it('leaves exact values untouched', () => {
    for (const value of [0, 1, -1, 0.5, 2.25, 1234.56, 1e21, -3.5e-7]) {
      expect(stripFloatNoise(value)).toBe(value);
    }
  });

  it('never rounds an integer (that would lose, not tidy, precision)', () => {
    expect(stripFloatNoise(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(stripFloatNoise(-9007199254740991)).toBe(-9007199254740991);
  });

  it('preserves genuine precision up to 15 significant digits', () => {
    expect(stripFloatNoise(123456789.012345)).toBe(123456789.012345);
    expect(stripFloatNoise(0.000123456789012345)).toBe(0.000123456789012345);
  });

  it('passes non-finite values through unchanged', () => {
    expect(stripFloatNoise(Number.NaN)).toBeNaN();
    expect(stripFloatNoise(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(stripFloatNoise(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});
