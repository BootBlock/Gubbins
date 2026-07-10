import { describe, it, expect } from 'vitest';
import {
  LOCATION_COLORS,
  isLocationColor,
  locationColorLabel,
  locationColorSwatchClass,
  locationColorTextClass,
  locationColorTintClass,
} from './location-color';

describe('location-color', () => {
  it('offers exactly the 12 documented swatches', () => {
    expect(LOCATION_COLORS).toHaveLength(12);
    expect(LOCATION_COLORS).toContain('teal');
    expect(LOCATION_COLORS).toContain('fuchsia');
  });

  it('recognises only known keys', () => {
    expect(isLocationColor('teal')).toBe(true);
    expect(isLocationColor('chartreuse')).toBe(false);
    expect(isLocationColor(null)).toBe(false);
    expect(isLocationColor(undefined)).toBe(false);
    expect(isLocationColor('')).toBe(false);
  });

  it('maps a known key to its static text utility', () => {
    expect(locationColorTextClass('teal')).toBe('text-loc-teal');
    expect(locationColorTextClass('rose')).toBe('text-loc-rose');
  });

  it('returns undefined for none / unknown so callers keep the default colour', () => {
    expect(locationColorTextClass(null)).toBeUndefined();
    expect(locationColorTextClass('nope')).toBeUndefined();
  });

  it('maps a known key to its F10 edge-tint classes, and none/unknown to undefined', () => {
    // The behaviour class + the swatch var-setter, both hand-authored in styles/index.css.
    expect(locationColorTintClass('teal')).toBe('gubbins-loc-tint loc-tint-teal');
    expect(locationColorTintClass('rose')).toBe('gubbins-loc-tint loc-tint-rose');
    // No colour / an unrecognised key ⇒ no tint, so those items stay a neutral card.
    expect(locationColorTintClass(null)).toBeUndefined();
    expect(locationColorTintClass(undefined)).toBeUndefined();
    expect(locationColorTintClass('nope')).toBeUndefined();
  });

  it('exposes a swatch fill class and a label for every colour', () => {
    for (const color of LOCATION_COLORS) {
      expect(locationColorSwatchClass(color)).toBe(`bg-loc-${color}`);
      expect(locationColorLabel(color)).toMatch(/^[A-Z]/);
    }
  });
});
