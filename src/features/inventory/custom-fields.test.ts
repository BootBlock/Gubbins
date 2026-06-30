import { describe, it, expect } from 'vitest';
import type { CategoryField, FieldType } from '@/db/repositories';
import { validateFieldValue, fieldsForCategory } from './custom-fields';

/** Build a minimal CategoryField definition for tests. */
function def(over: Partial<CategoryField> & { fieldType: FieldType }): CategoryField {
  return {
    id: over.id ?? 'f1',
    categoryId: over.categoryId ?? 'c1',
    name: over.name ?? 'Field',
    fieldType: over.fieldType,
    options: over.options ?? null,
    isRequired: over.isRequired ?? false,
    defaultValue: over.defaultValue ?? null,
    position: over.position ?? 0,
    updatedAt: over.updatedAt ?? 0,
  };
}

describe('validateFieldValue — blank / required handling', () => {
  it('clears an optional field to null on blank/empty/whitespace', () => {
    const d = def({ fieldType: 'TEXT', isRequired: false });
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      expect(validateFieldValue(d, raw)).toEqual({ ok: true, value: null });
    }
  });

  it('errors on a blank required field, naming it', () => {
    const d = def({ fieldType: 'NUMBER', isRequired: true, name: 'Voltage' });
    const r = validateFieldValue(d, '   ');
    expect(r).toEqual({ ok: false, error: 'Voltage is required.' });
  });

  it('accepts a satisfied required field', () => {
    const d = def({ fieldType: 'TEXT', isRequired: true, name: 'Notes' });
    expect(validateFieldValue(d, 'present')).toEqual({ ok: true, value: 'present' });
  });
});

describe('validateFieldValue — TEXT', () => {
  it('trims the value', () => {
    expect(validateFieldValue(def({ fieldType: 'TEXT' }), '  hello  ')).toEqual({
      ok: true,
      value: 'hello',
    });
  });
});

describe('validateFieldValue — NUMBER', () => {
  it('re-serialises canonically', () => {
    const d = def({ fieldType: 'NUMBER' });
    expect(validateFieldValue(d, '1.50')).toEqual({ ok: true, value: '1.5' });
    expect(validateFieldValue(d, '01')).toEqual({ ok: true, value: '1' });
    expect(validateFieldValue(d, '  42 ')).toEqual({ ok: true, value: '42' });
    expect(validateFieldValue(d, '-0')).toEqual({ ok: true, value: '0' });
    expect(validateFieldValue(d, '1e3')).toEqual({ ok: true, value: '1000' });
  });

  it('rejects malformed / non-finite numbers, naming the field', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Resistance' });
    for (const bad of ['1.2.3', 'abc', 'Infinity', '-Infinity', 'NaN', '12px']) {
      expect(validateFieldValue(d, bad)).toEqual({
        ok: false,
        error: 'Resistance must be a number.',
      });
    }
  });

  it('accepts a hex literal as the finite number it denotes', () => {
    // `Number('0x10')` is a legitimate finite 16; canonicalised to decimal '16'.
    expect(validateFieldValue(def({ fieldType: 'NUMBER' }), '0x10')).toEqual({
      ok: true,
      value: '16',
    });
  });
});

describe('validateFieldValue — BOOLEAN', () => {
  it('normalises case-insensitively to true/false', () => {
    const d = def({ fieldType: 'BOOLEAN' });
    expect(validateFieldValue(d, 'true')).toEqual({ ok: true, value: 'true' });
    expect(validateFieldValue(d, 'TRUE')).toEqual({ ok: true, value: 'true' });
    expect(validateFieldValue(d, 'False')).toEqual({ ok: true, value: 'false' });
  });

  it('rejects non-boolean text', () => {
    const d = def({ fieldType: 'BOOLEAN', name: 'In stock' });
    for (const bad of ['yes', '1', '0', 'maybe']) {
      expect(validateFieldValue(d, bad)).toEqual({
        ok: false,
        error: 'In stock must be true or false.',
      });
    }
  });
});

describe('validateFieldValue — DATE', () => {
  it('canonicalises a valid ISO date', () => {
    const d = def({ fieldType: 'DATE' });
    expect(validateFieldValue(d, '2026-06-30')).toEqual({ ok: true, value: '2026-06-30' });
    expect(validateFieldValue(d, '  2024-02-29 ')).toEqual({ ok: true, value: '2024-02-29' });
  });

  it('rejects impossible / malformed dates', () => {
    const d = def({ fieldType: 'DATE', name: 'Calibrated' });
    for (const bad of ['2026-13-40', '2026-02-30', '2026-00-10', 'not-a-date', '30-06-2026', '2026/06/30']) {
      expect(validateFieldValue(d, bad)).toEqual({
        ok: false,
        error: 'Calibrated must be a valid date (YYYY-MM-DD).',
      });
    }
  });

  it('rejects 29 Feb in a non-leap year', () => {
    expect(validateFieldValue(def({ fieldType: 'DATE' }), '2025-02-29').ok).toBe(false);
  });
});

describe('validateFieldValue — SELECT', () => {
  it('accepts a value in the option list', () => {
    const d = def({ fieldType: 'SELECT', options: ['X7R', 'C0G'] });
    expect(validateFieldValue(d, 'C0G')).toEqual({ ok: true, value: 'C0G' });
  });

  it('rejects a value not in the option list, listing the options', () => {
    const d = def({ fieldType: 'SELECT', name: 'Dielectric', options: ['X7R', 'C0G'] });
    expect(validateFieldValue(d, 'NP0')).toEqual({
      ok: false,
      error: 'Dielectric must be one of: X7R, C0G.',
    });
  });

  it('rejects any value when options is null', () => {
    const d = def({ fieldType: 'SELECT', name: 'Dielectric', options: null });
    expect(validateFieldValue(d, 'anything').ok).toBe(false);
  });
});

describe('fieldsForCategory', () => {
  it('filters to the named category only (flat — no ancestor resolution)', () => {
    const a = def({ id: 'a', categoryId: 'c1', name: 'A' });
    const b = def({ id: 'b', categoryId: 'c2', name: 'B' });
    expect(fieldsForCategory([a, b], 'c1').map((f) => f.id)).toEqual(['a']);
  });

  it('orders by position then name (NOCASE), matching the repo ORDER BY', () => {
    const fields = [
      def({ id: 'z', categoryId: 'c1', name: 'zeta', position: 1 }),
      def({ id: 'b', categoryId: 'c1', name: 'beta', position: 0 }),
      def({ id: 'A', categoryId: 'c1', name: 'Alpha', position: 0 }),
    ];
    expect(fieldsForCategory(fields, 'c1').map((f) => f.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const fields = [
      def({ id: '2', categoryId: 'c1', name: 'two', position: 1 }),
      def({ id: '1', categoryId: 'c1', name: 'one', position: 0 }),
    ];
    const order = fields.map((f) => f.id);
    fieldsForCategory(fields, 'c1');
    expect(fields.map((f) => f.id)).toEqual(order);
  });
});
