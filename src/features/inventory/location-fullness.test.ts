import { describe, it, expect } from 'vitest';
import { locationFullness, isLocationFull } from './location-fullness';

describe('locationFullness', () => {
  it('returns null when there is no positive capacity', () => {
    expect(locationFullness(5, null)).toBeNull();
    expect(locationFullness(5, undefined)).toBeNull();
    expect(locationFullness(5, 0)).toBeNull();
    expect(locationFullness(5, -1)).toBeNull();
  });

  it('computes a rounded, clamped percentage', () => {
    expect(locationFullness(0, 10)?.percent).toBe(0);
    expect(locationFullness(5, 10)?.percent).toBe(50);
    expect(locationFullness(1, 3)?.percent).toBe(33);
    // Over capacity saturates the display at 100 but flags `over`.
    expect(locationFullness(15, 10)?.percent).toBe(100);
  });

  it('reports full and over states distinctly', () => {
    expect(locationFullness(9, 10)).toMatchObject({ full: false, over: false });
    expect(locationFullness(10, 10)).toMatchObject({ full: true, over: false });
    expect(locationFullness(11, 10)).toMatchObject({ full: true, over: true });
  });
});

describe('isLocationFull', () => {
  it('is false without a positive capacity', () => {
    expect(isLocationFull(100, null)).toBe(false);
    expect(isLocationFull(100, 0)).toBe(false);
  });

  it('is true when adding would exceed the capacity', () => {
    expect(isLocationFull(9, 10)).toBe(false); // 9 + 1 = 10, still fits
    expect(isLocationFull(10, 10)).toBe(true); // 10 + 1 = 11, over
    expect(isLocationFull(8, 10, 3)).toBe(true); // 8 + 3 = 11, over
  });
});
