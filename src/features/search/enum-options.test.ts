import { describe, expect, it } from 'vitest';
import { enumOptionsForField } from './enum-options';
import { enumValuesForField } from './fields';

/**
 * The Visual Builder's fixed-vocabulary pickers (issue #140). The values must be the ones the
 * column stores; the labels must be the ones the rest of the app already shows.
 */
describe('enumOptionsForField', () => {
  it("labels members with the app's own wording, not a spelling of the stored value", () => {
    expect(enumOptionsForField('condition')).toContainEqual({
      value: 'NEEDS_REPAIR',
      label: 'Needs repair',
    });
    // The two vocabularies that deliberately differ from their stored value: the item editor
    // calls DISCRETE "Bulk", and the dead-stock setting calls `always` "Report".
    expect(enumOptionsForField('tracking')).toContainEqual({ value: 'DISCRETE', label: 'Bulk' });
    expect(enumOptionsForField('deadstock')).toContainEqual({ value: 'always', label: 'Report' });
  });

  it('offers every member the column accepts, and gives each one a label', () => {
    for (const field of ['condition', 'tracking', 'deadstock']) {
      const options = enumOptionsForField(field);
      expect(options.map((o) => o.value)).toEqual([...enumValuesForField(field)]);
      // A member with no entry in a label map would fall back to its raw stored spelling.
      expect(options.every((o) => o.label !== o.value)).toBe(true);
    }
  });

  it('offers nothing for a field that is not an enum', () => {
    expect(enumOptionsForField('quantity')).toEqual([]);
    expect(enumOptionsForField('not-a-field')).toEqual([]);
  });
});
