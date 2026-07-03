import { describe, it, expect } from 'vitest';
import { PRESET_SUGGESTIONS, mergeSuggestions } from './field-suggestions';

describe('mergeSuggestions — union of existing values and seeded presets', () => {
  it('unions both sources, sorted case-insensitively A→Z', () => {
    const merged = mergeSuggestions(['Yageo', 'Acme'], ['Bourns', 'Texas Instruments']);
    expect(merged).toEqual(['Acme', 'Bourns', 'Texas Instruments', 'Yageo']);
  });

  it('de-duplicates case-insensitively, keeping the user’s own spelling/casing', () => {
    // The preset seeds "onsemi"; the user typed "OnSemi" — their casing must win, once.
    const merged = mergeSuggestions(['OnSemi'], ['onsemi', 'Murata']);
    expect(merged).toEqual(['Murata', 'OnSemi']);
    expect(merged.filter((v) => v.toLowerCase() === 'onsemi')).toHaveLength(1);
  });

  it('drops blank / whitespace-only entries from either source', () => {
    expect(mergeSuggestions(['  ', ''], ['Vishay', '   '])).toEqual(['Vishay']);
  });

  it('returns just the presets when there are no existing values', () => {
    expect(mergeSuggestions([], ['B', 'a', 'C'])).toEqual(['a', 'B', 'C']);
  });
});

describe('PRESET_SUGGESTIONS — seeded defaults', () => {
  it('has non-empty, unique, trimmed values for every field', () => {
    for (const [field, values] of Object.entries(PRESET_SUGGESTIONS)) {
      expect(values.length, `${field} should seed some defaults`).toBeGreaterThan(0);
      const keys = values.map((v) => v.trim().toLowerCase());
      expect(new Set(keys).size, `${field} presets must be unique`).toBe(values.length);
      for (const v of values) expect(v, `${field} preset must be trimmed`).toBe(v.trim());
    }
  });

  it('seeds the obvious electronics names so an empty catalogue still completes them', () => {
    expect(PRESET_SUGGESTIONS.manufacturer).toContain('Texas Instruments');
    expect(PRESET_SUGGESTIONS.supplierName).toContain('DigiKey');
    expect(PRESET_SUGGESTIONS.unitOfMeasure).toContain('g');
  });
});
