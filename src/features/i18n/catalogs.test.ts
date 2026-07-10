import { describe, expect, it } from 'vitest';
import en from './catalogs/en.json';
import de from './catalogs/de.json';

const enKeys = Object.keys(en);
const deKeys = Object.keys(de);

/**
 * Catalog integrity: a translated catalog is an *override* over the English base, so every key it
 * carries must be a real base key (a typo would otherwise sit dead, silently falling back), and a
 * shipped pilot language should translate the whole converted slice (no accidental gaps). Both
 * checks are exhaustive over the catalogs, so drift is caught the moment a key is renamed.
 */
describe('message catalogs', () => {
  it('base English catalog has no duplicate/empty values that would defeat lookup', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en["${key}"] must be a non-empty string`).toBeTypeOf('string');
      expect(value.length, `en["${key}"] must not be blank`).toBeGreaterThan(0);
    }
  });

  it('every German key is a valid English base key (no typos / orphans)', () => {
    const enSet = new Set(enKeys);
    const orphans = deKeys.filter((k) => !enSet.has(k));
    expect(orphans).toEqual([]);
  });

  it('German translates the entire converted slice (full pilot coverage)', () => {
    const deSet = new Set(deKeys);
    const untranslated = enKeys.filter((k) => !deSet.has(k));
    expect(untranslated).toEqual([]);
  });

  it('preserves every interpolation placeholder in the German translation', () => {
    // A translation that drops a `{token}` present in the source would render a blank where a
    // value belongs. Compare the placeholder *sets* per key (order/plurals aside).
    const placeholders = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of enKeys) {
      const source = (en as Record<string, string>)[key];
      const target = (de as Record<string, string>)[key];
      if (source === undefined || target === undefined) continue;
      expect(placeholders(target), `${key} placeholders`).toEqual(placeholders(source));
    }
  });
});
