/**
 * The catalogue's membership contract (issue #359).
 *
 * `isGlyphName` is the only way a plain stored string becomes a `GlyphName`, and the whole
 * point of that type is that {@link getGlyphIcon} can then promise a component. These tests
 * pin the runtime side of that bargain — including the one place the module asserts a type
 * rather than proving it, the `Object.keys(icons)` that seeds `GLYPH_NAMES`.
 */
import { describe, it, expect, vi } from 'vitest';
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

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited Object property %s, which is not a glyph',
    (name) => {
      expect(isGlyphName(name)).toBe(false);
    },
  );

  /*
   * …and rejects them however the catalogue is materialised. The bundler builds `icons` as an
   * ordinary object, which answers to `Object.prototype`'s keys, while the same import under
   * Vitest is a native module namespace with a null prototype — so a bare `in` check would
   * pass the assertions above and still hand `Object.prototype.toString` back as an "icon" in
   * the shipped app. Standing the module up over a plain object reproduces what runs in the
   * browser, and fails if membership ever stops being an own-property question.
   */
  it('treats membership as an own-property question, not a prototype-chain one', async () => {
    vi.resetModules();
    vi.doMock('lucide-react', () => ({ icons: { Rocket: () => null } }));
    try {
      const registry = await import('./glyph-registry');
      expect(registry.isGlyphName('Rocket')).toBe(true);
      expect(registry.isGlyphName('toString')).toBe(false);
      expect(registry.GLYPH_NAMES).toEqual(['Rocket']);
    } finally {
      vi.doUnmock('lucide-react');
      vi.resetModules();
    }
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
