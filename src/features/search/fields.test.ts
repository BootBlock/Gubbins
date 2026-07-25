import { describe, expect, it } from 'vitest';
import {
  customFieldName,
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

  it('labels HAS_CAPABILITY as "has any value" everywhere except a capability', () => {
    expect(operatorLabelFor('HAS_CAPABILITY', 'customfield')).toBe('has any value');
    expect(operatorLabelFor('HAS_CAPABILITY', 'text')).toBe('has any value');
    expect(operatorLabelFor('HAS_CAPABILITY', 'presence')).toBe('has any value');
    expect(operatorLabelFor('HAS_CAPABILITY', 'capability')).toBe('has capability');
    expect(operatorLabelFor('CONTAINS', 'customfield')).toBe('contains');
  });

  it('offers presence on text and number fields so a has: term round-trips (issue #139)', () => {
    expect(operatorsForKind('text')).toEqual(['CONTAINS', 'EQUALS', 'HAS_CAPABILITY']);
    expect(operatorsForKind('number')).toEqual(['GREATER_THAN', 'LESS_THAN', 'EQUALS', 'HAS_CAPABILITY']);
  });

  it('offers only presence for an id-keyed field with no value picker (issue #139)', () => {
    expect(kindOfField('category')).toBe('presence');
    expect(operatorsForKind('presence')).toEqual(['HAS_CAPABILITY']);
    expect(fieldSelectValue('category')).toBe('category');
  });

  it('offers only EQUALS (read as "is") for the boolean favourite field (issue #23)', () => {
    expect(kindOfField('favourite')).toBe('boolean');
    expect(operatorsForKind('boolean')).toEqual(['EQUALS']);
    expect(operatorLabelFor('EQUALS', 'boolean')).toBe('is');
    expect(operatorLabelFor('EQUALS', 'number')).toBe('equals');
  });
});
