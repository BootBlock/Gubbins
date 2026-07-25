import { describe, expect, it } from 'vitest';
import { CONDITIONS, DEAD_STOCK_MODES } from '@/db/repositories/constants';
import {
  BUILDER_FIELDS,
  customFieldName,
  enumValuesForField,
  fieldSelectValue,
  isCustomField,
  kindOfField,
  operatorLabelFor,
  operatorsForKind,
  toCustomField,
} from './fields';

/**
 * Field/operator metadata for the Visual Builder (spec §5.1). Phase 71 adds the
 * `field:<name>` custom-field form, mirroring the `capability:<key>` helpers.
 */
describe('custom-field helpers (Phase 71)', () => {
  it('round-trips a name through toCustomField / customFieldName', () => {
    expect(toCustomField('Datasheet')).toBe('field:Datasheet');
    expect(customFieldName('field:Datasheet')).toBe('Datasheet');
  });

  it('trims when composing a custom-field identifier', () => {
    expect(toCustomField('  Notes  ')).toBe('field:Notes');
  });

  it('recognises a custom-field reference case-insensitively', () => {
    expect(isCustomField('field:Notes')).toBe(true);
    expect(isCustomField('FIELD:Notes')).toBe(true);
    expect(isCustomField('capability:voltage')).toBe(false);
    expect(isCustomField('name')).toBe(false);
  });

  it('customFieldName is empty for a non-custom field', () => {
    expect(customFieldName('name')).toBe('');
  });

  it('maps a custom field to the customfield dropdown value and kind', () => {
    expect(fieldSelectValue('field:Notes')).toBe('customfield');
    expect(kindOfField('field:Notes')).toBe('customfield');
  });

  it('offers contains/equals/compare/presence operators for a custom field', () => {
    expect(operatorsForKind('customfield')).toEqual([
      'CONTAINS',
      'EQUALS',
      'GREATER_THAN',
      'LESS_THAN',
      'HAS_CAPABILITY',
    ]);
  });

  it('labels HAS_CAPABILITY as "has any value" on a custom field but "has capability" elsewhere', () => {
    expect(operatorLabelFor('HAS_CAPABILITY', 'customfield')).toBe('has any value');
    expect(operatorLabelFor('HAS_CAPABILITY', 'capability')).toBe('has capability');
    expect(operatorLabelFor('CONTAINS', 'customfield')).toBe('contains');
  });

  it('offers only EQUALS (read as "is") for the boolean favourite field (issue #23)', () => {
    expect(kindOfField('favourite')).toBe('boolean');
    expect(operatorsForKind('boolean')).toEqual(['EQUALS']);
    expect(operatorLabelFor('EQUALS', 'boolean')).toBe('is');
    expect(operatorLabelFor('EQUALS', 'number')).toBe('equals');
  });
});

describe('lifecycle, valuation & policy fields (issue #140)', () => {
  it('maps each new field to the kind that decides its input control', () => {
    expect(kindOfField('condition')).toBe('enum');
    expect(kindOfField('tracking')).toBe('enum');
    expect(kindOfField('deadstock')).toBe('enum');
    expect(kindOfField('expiry')).toBe('date');
    expect(kindOfField('warranty')).toBe('date');
    expect(kindOfField('cost')).toBe('number');
    expect(kindOfField('active')).toBe('boolean');
  });

  it('offers a date field before/after/on rather than the numeric operator wording', () => {
    expect(operatorsForKind('date')).toEqual(['LESS_THAN', 'GREATER_THAN', 'EQUALS']);
    expect(operatorLabelFor('LESS_THAN', 'date')).toBe('before');
    expect(operatorLabelFor('GREATER_THAN', 'date')).toBe('after');
    expect(operatorLabelFor('EQUALS', 'date')).toBe('on');
    // The same operators keep their numeric wording elsewhere.
    expect(operatorLabelFor('LESS_THAN', 'number')).toBe('less than');
  });

  it('offers only EQUALS (read as "is") for an enum field', () => {
    expect(operatorsForKind('enum')).toEqual(['EQUALS']);
    expect(operatorLabelFor('EQUALS', 'enum')).toBe('is');
  });

  it("takes an enum picker's options from the column vocabulary, not a second list", () => {
    expect(enumValuesForField('condition')).toEqual([...CONDITIONS]);
    expect(enumValuesForField('deadstock')).toEqual([...DEAD_STOCK_MODES]);
    // Any other kind has no vocabulary to offer.
    expect(enumValuesForField('quantity')).toEqual([]);
  });

  it('gives every new field a label, so the builder dropdown never shows a blank', () => {
    for (const field of ['condition', 'tracking', 'deadstock', 'expiry', 'warranty', 'cost', 'active']) {
      expect(BUILDER_FIELDS.find((f) => f.value === field)?.label).toBeTruthy();
    }
  });
});
