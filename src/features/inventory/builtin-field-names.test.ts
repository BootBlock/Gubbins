import { describe, it, expect } from 'vitest';
import { BUILT_IN_ITEM_FIELD_NAMES, builtInFieldNameClash } from './builtin-field-names';

describe('builtInFieldNameClash (issue #97 follow-up)', () => {
  it('flags the issue’s own example — a custom field named "Manufacturer"', () => {
    expect(builtInFieldNameClash('Manufacturer')).toBe('Manufacturer');
  });

  it('matches case-insensitively and ignores surrounding space, like the NOCASE index', () => {
    expect(builtInFieldNameClash('manufacturer')).toBe('Manufacturer');
    expect(builtInFieldNameClash('  MANUFACTURER  ')).toBe('Manufacturer');
  });

  it('matches a unit-suffixed built-in by the bare name the user would actually type', () => {
    // The registry label is "Weight (g)"; nobody names a custom field that.
    expect(builtInFieldNameClash('Weight')).toBe('Weight');
    expect(builtInFieldNameClash('Weight (g)')).toBe('Weight');
  });

  it('returns undefined for a genuinely new field name', () => {
    expect(builtInFieldNameClash('Voltage')).toBeUndefined();
    expect(builtInFieldNameClash('Shelf load rating')).toBeUndefined();
  });

  it('treats a blank name as no collision, so an empty form is not warned at', () => {
    expect(builtInFieldNameClash('')).toBeUndefined();
    expect(builtInFieldNameClash('   ')).toBeUndefined();
  });

  it('covers the built-ins a user is most likely to duplicate', () => {
    for (const name of ['Name', 'Notes', 'Quantity', 'Location', 'Category', 'Condition', 'Tags']) {
      expect(builtInFieldNameClash(name), `${name} should be recognised`).toBeDefined();
    }
  });

  it('exposes a de-duplicated, sorted catalog', () => {
    expect(new Set(BUILT_IN_ITEM_FIELD_NAMES).size).toBe(BUILT_IN_ITEM_FIELD_NAMES.length);
    expect([...BUILT_IN_ITEM_FIELD_NAMES].sort((a, b) => a.localeCompare(b))).toEqual(
      BUILT_IN_ITEM_FIELD_NAMES,
    );
  });

  it('never offers the pseudo-fields the search builder uses as markers', () => {
    // "Capability" and "Custom field" are builder affordances, not item attributes.
    expect(builtInFieldNameClash('Capability')).toBeUndefined();
    expect(builtInFieldNameClash('Custom field')).toBeUndefined();
  });
});
