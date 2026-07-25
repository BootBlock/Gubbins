/**
 * The catalogue's membership contract (issue #359).
 *
 * `isGlyphName` is the only way a plain stored string becomes a `GlyphName`, and the whole
 * point of that type is that {@link getGlyphIcon} can then promise a component. These tests
 * pin the runtime side of that bargain — including the one place the module asserts a type
 * rather than proving it, the `Object.keys(icons)` that seeds `GLYPH_NAMES`.
 */
import { describe, it, expect } from 'vitest';
import { GLYPH_NAMES, getGlyphIcon, isGlyphName } from './glyph-registry';

describe('isGlyphName', () => {
  it('accepts a catalogue name', () => {
    expect(isGlyphName('Rocket')).toBe(true);
  });

  it('rejects a name that is not in the catalogue', () => {
    expect(isGlyphName('NotARealGlyphName')).toBe(false);
  });

  it('rejects an absent name', () => {
    expect(isGlyphName(null)).toBe(false);
    expect(isGlyphName(undefined)).toBe(false);
  });

  it('rejects an inherited Object property, which is not a glyph', () => {
    expect(isGlyphName('toString')).toBe(false);
  });
});

describe('GLYPH_NAMES', () => {
  it('holds the whole catalogue, sorted', () => {
    expect(GLYPH_NAMES.length).toBeGreaterThan(1000);
    expect([...GLYPH_NAMES]).toEqual([...GLYPH_NAMES].sort((a, b) => a.localeCompare(b)));
  });

  it('contains only real glyph names, each of which resolves to a component', () => {
    expect(GLYPH_NAMES.filter((name) => !isGlyphName(name))).toEqual([]);
    expect(GLYPH_NAMES.filter((name) => !getGlyphIcon(name))).toEqual([]);
  });
});
