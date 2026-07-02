import { describe, expect, it } from 'vitest';
import {
  isBulkEditEmpty,
  parseTagInput,
  resolveItemTagNames,
  summariseBulkEdit,
  type BulkEditLookups,
  type BulkEditSpec,
} from './bulk-edit';

const lookups: BulkEditLookups = {
  categoryName: (id) => ({ c1: 'Resistors', c2: 'Capacitors' })[id] ?? id,
  locationName: (id) => ({ l1: 'Drawer A' })[id] ?? id,
  conditionLabel: (c) =>
    ({
      MINT: 'Mint',
      GOOD: 'Good',
      NEEDS_REPAIR: 'Needs repair',
      OUT_FOR_CALIBRATION: 'Out for calibration',
    })[c],
};

describe('isBulkEditEmpty', () => {
  it('is empty for {} and for a tag change with no names', () => {
    expect(isBulkEditEmpty({})).toBe(true);
    expect(isBulkEditEmpty({ tags: { mode: 'add', names: [] } })).toBe(true);
  });

  it('is non-empty when any field (including a null-valued clear) is present', () => {
    expect(isBulkEditEmpty({ category: { value: null } })).toBe(false);
    expect(isBulkEditEmpty({ condition: { value: null } })).toBe(false);
    expect(isBulkEditEmpty({ location: { value: 'l1' } })).toBe(false);
    expect(isBulkEditEmpty({ active: { value: false } })).toBe(false);
    expect(isBulkEditEmpty({ tags: { mode: 'replace', names: ['a'] } })).toBe(false);
  });
});

describe('parseTagInput', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseTagInput('  a, b ,, c ,  ')).toEqual(['a', 'b', 'c']);
    expect(parseTagInput('   ')).toEqual([]);
  });
});

describe('resolveItemTagNames', () => {
  it('add merges current + new, deduping case-insensitively (current casing wins)', () => {
    expect(resolveItemTagNames(['Alpha', 'Beta'], { mode: 'add', names: ['beta', 'Gamma'] })).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('replace uses only the new names, deduped', () => {
    expect(resolveItemTagNames(['Alpha', 'Beta'], { mode: 'replace', names: ['x', 'X', 'y'] })).toEqual([
      'x',
      'y',
    ]);
  });

  it('ignores blank names', () => {
    expect(resolveItemTagNames([], { mode: 'add', names: ['  ', 'a'] })).toEqual(['a']);
  });
});

describe('summariseBulkEdit', () => {
  it('renders one readable line per changed field', () => {
    const spec: BulkEditSpec = {
      category: { value: 'c1' },
      location: { value: 'l1' },
      condition: { value: 'NEEDS_REPAIR' },
      active: { value: false },
      tags: { mode: 'add', names: ['t1', 't2'] },
    };
    expect(summariseBulkEdit(spec, lookups)).toEqual([
      'Category → Resistors',
      'Location → Drawer A',
      'Condition → Needs repair',
      'State → Removed',
      'Tags → add 2',
    ]);
  });

  it('renders "cleared" for null category/condition and the replace verb', () => {
    expect(
      summariseBulkEdit(
        { category: { value: null }, condition: { value: null }, tags: { mode: 'replace', names: ['a'] } },
        lookups,
      ),
    ).toEqual(['Category → cleared', 'Condition → cleared', 'Tags → replace with 1']);
  });

  it('omits a tag line when there are no names, and is empty for {}', () => {
    expect(summariseBulkEdit({ tags: { mode: 'add', names: [] } }, lookups)).toEqual([]);
    expect(summariseBulkEdit({}, lookups)).toEqual([]);
  });
});
