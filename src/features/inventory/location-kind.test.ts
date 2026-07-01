import { describe, it, expect } from 'vitest';
import { LOCATION_KINDS, isLocationKind, locationKindLabel } from './location-kind';

describe('location-kind', () => {
  it('offers exactly the ten documented types', () => {
    expect(LOCATION_KINDS).toHaveLength(10);
    expect(LOCATION_KINDS).toContain('cabinet');
    expect(LOCATION_KINDS).toContain('vehicle');
  });

  it('recognises only known keys', () => {
    expect(isLocationKind('cabinet')).toBe(true);
    expect(isLocationKind('spaceship')).toBe(false);
    expect(isLocationKind(null)).toBe(false);
    expect(isLocationKind(undefined)).toBe(false);
    expect(isLocationKind('')).toBe(false);
  });

  it('labels every known key and returns undefined for none/unknown', () => {
    for (const kind of LOCATION_KINDS) {
      expect(locationKindLabel(kind)).toMatch(/^[A-Z]/);
    }
    expect(locationKindLabel(null)).toBeUndefined();
    expect(locationKindLabel('nope')).toBeUndefined();
  });
});
