import { describe, expect, it } from 'vitest';
import {
  BUILDER_FIELDS,
  customFieldName,
  fieldSelectValue,
  isCapabilityField,
  isCustomField,
  isTagField,
  kindOfField,
  operatorLabelFor,
  operatorsForKind,
  TAG_FIELD,
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

describe('the tag field (issue #138)', () => {
  it('is offered by the builder, matched by name like any other text field', () => {
    expect(BUILDER_FIELDS.find((f) => f.value === TAG_FIELD)).toEqual({
      value: 'tag',
      label: 'Tag',
      kind: 'text',
    });
    expect(kindOfField(TAG_FIELD)).toBe('text');
    expect(fieldSelectValue(TAG_FIELD)).toBe('tag');
    expect(operatorsForKind('text')).toEqual(['CONTAINS', 'EQUALS']);
  });

  it('is recognised by isTagField, case-insensitively', () => {
    expect(isTagField('tag')).toBe(true);
    expect(isTagField('TAG')).toBe(true);
    expect(isTagField('name')).toBe(false);
    expect(isTagField('field:Tag')).toBe(false);
  });

  it('is not mistaken for a capability or custom-field reference', () => {
    expect(isCustomField(TAG_FIELD)).toBe(false);
    expect(isCapabilityField(TAG_FIELD)).toBe(false);
  });
});
