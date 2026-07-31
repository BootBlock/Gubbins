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
    unit: over.unit ?? null,
    minValue: over.minValue ?? null,
    maxValue: over.maxValue ?? null,
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

describe('validateFieldValue — LONG_TEXT', () => {
  it('trims the value but keeps internal newlines', () => {
    expect(validateFieldValue(def({ fieldType: 'LONG_TEXT' }), '  line one\nline two  ')).toEqual({
      ok: true,
      value: 'line one\nline two',
    });
  });
});

describe('validateFieldValue — URL', () => {
  it('accepts an absolute http(s) URL', () => {
    const d = def({ fieldType: 'URL' });
    expect(validateFieldValue(d, 'https://example.com/datasheet.pdf')).toEqual({
      ok: true,
      value: 'https://example.com/datasheet.pdf',
    });
    expect(validateFieldValue(d, 'http://example.com')).toEqual({ ok: true, value: 'http://example.com' });
  });

  it('rejects a non-URL or a non-http(s) scheme, naming the field', () => {
    const d = def({ fieldType: 'URL', name: 'Datasheet' });
    expect(validateFieldValue(d, 'not a url')).toEqual({
      ok: false,
      error: 'Datasheet must be a valid URL.',
    });
    expect(validateFieldValue(d, 'ftp://example.com/file')).toEqual({
      ok: false,
      error: 'Datasheet must be a valid http(s) URL.',
    });
  });
});

describe('validateFieldValue — RATING', () => {
  it('accepts a whole number from 1 to 5', () => {
    const d = def({ fieldType: 'RATING' });
    for (const n of ['1', '3', '5']) {
      expect(validateFieldValue(d, n)).toEqual({ ok: true, value: n });
    }
  });

  it('rejects out-of-range or non-integer values, naming the field', () => {
    const d = def({ fieldType: 'RATING', name: 'Condition' });
    for (const bad of ['0', '6', '2.5', 'abc']) {
      expect(validateFieldValue(d, bad)).toEqual({
        ok: false,
        error: 'Condition must be a whole number from 1 to 5.',
      });
    }
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

describe('validateFieldValue — NUMBER range (W1c)', () => {
  it('accepts anything when neither bound is set', () => {
    const d = def({ fieldType: 'NUMBER' });
    for (const raw of ['-9999999', '0', '3.14', '9999999']) {
      expect(validateFieldValue(d, raw).ok).toBe(true);
    }
  });

  it('enforces a two-ended range, inclusive at both ends', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Torque', minValue: 8, maxValue: 12 });
    expect(validateFieldValue(d, '8')).toEqual({ ok: true, value: '8' });
    expect(validateFieldValue(d, '12')).toEqual({ ok: true, value: '12' });
    expect(validateFieldValue(d, '10.5')).toEqual({ ok: true, value: '10.5' });
    expect(validateFieldValue(d, '7.99')).toEqual({
      ok: false,
      error: 'Torque must be between 8 and 12.',
    });
    expect(validateFieldValue(d, '12.01')).toEqual({
      ok: false,
      error: 'Torque must be between 8 and 12.',
    });
  });

  // A one-sided range is a first-class constraint, not a half-finished one: `null` on either
  // end means *unbounded that side*, so each is enforced without inventing the other.
  it('enforces a floor alone, leaving the field unbounded above', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Depth', minValue: 0 });
    expect(validateFieldValue(d, '0')).toEqual({ ok: true, value: '0' });
    expect(validateFieldValue(d, '1e9')).toEqual({ ok: true, value: '1000000000' });
    expect(validateFieldValue(d, '-0.5')).toEqual({
      ok: false,
      error: 'Depth must be at least 0.',
    });
  });

  it('enforces a ceiling alone, leaving the field unbounded below', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Charge', maxValue: 100 });
    expect(validateFieldValue(d, '100')).toEqual({ ok: true, value: '100' });
    expect(validateFieldValue(d, '-500')).toEqual({ ok: true, value: '-500' });
    expect(validateFieldValue(d, '101')).toEqual({
      ok: false,
      error: 'Charge must be at most 100.',
    });
  });

  it('accepts exactly one value when the bounds are equal', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Poles', minValue: 2, maxValue: 2 });
    expect(validateFieldValue(d, '2')).toEqual({ ok: true, value: '2' });
    expect(validateFieldValue(d, '3').ok).toBe(false);
  });

  it('quotes the bound in the field’s unit when it has one', () => {
    const d = def({ fieldType: 'NUMBER', name: 'Voltage', unit: 'V', maxValue: 24 });
    expect(validateFieldValue(d, '25')).toEqual({
      ok: false,
      error: 'Voltage must be at most 24 V.',
    });
    expect(
      validateFieldValue(
        def({ fieldType: 'NUMBER', name: 'Voltage', unit: 'V', minValue: 3, maxValue: 24 }),
        '1',
      ),
    ).toEqual({ ok: false, error: 'Voltage must be between 3 and 24 V.' });
  });

  it('lets a blank clear an optional field regardless of its range', () => {
    // The blank guard runs before the range, so "unset" is never mistaken for "out of range".
    const d = def({ fieldType: 'NUMBER', minValue: 10, maxValue: 20, isRequired: false });
    expect(validateFieldValue(d, '')).toEqual({ ok: true, value: null });
  });

  it('applies the range to a location’s value, not just an item’s', () => {
    // A location value is validated through this same seam with `isRequired` forced false
    // (see `setLocationFieldValue`), so the bounds must survive that narrowing — otherwise an
    // inherited value could sit outside the range every item below it is held to.
    const d = def({ fieldType: 'NUMBER', name: 'Voltage', maxValue: 24, isRequired: false });
    expect(validateFieldValue({ ...d, isRequired: false }, '30')).toEqual({
      ok: false,
      error: 'Voltage must be at most 24.',
    });
  });

  it('ignores a range on any type other than NUMBER', () => {
    // The bounds are NUMBER-only by schema CHECK; a stale object carrying them on another type
    // must not start rejecting values that type has always accepted.
    const d = def({ fieldType: 'TEXT', name: 'Notes', minValue: 5, maxValue: 6 });
    expect(validateFieldValue(d, 'anything at all')).toEqual({ ok: true, value: 'anything at all' });
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

describe('validateFieldValue — ON_OFF', () => {
  it('normalises case-insensitively to true/false, identically to BOOLEAN', () => {
    const d = def({ fieldType: 'ON_OFF' });
    expect(validateFieldValue(d, 'true')).toEqual({ ok: true, value: 'true' });
    expect(validateFieldValue(d, 'FALSE')).toEqual({ ok: true, value: 'false' });
  });

  it('rejects non-boolean text', () => {
    const d = def({ fieldType: 'ON_OFF', name: 'Powered' });
    expect(validateFieldValue(d, 'on')).toEqual({
      ok: false,
      error: 'Powered must be true or false.',
    });
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

describe('validateFieldValue — FILE', () => {
  it('accepts any non-blank pointer string verbatim', () => {
    const d = def({ fieldType: 'FILE' });
    for (const raw of [String.raw`\\nas\media\movie.mkv`, 'file:///C:/movies/a.mp4', 'https://x.test/a']) {
      expect(validateFieldValue(d, raw)).toEqual({ ok: true, value: raw });
    }
  });

  it('trims surrounding whitespace and clears on blank', () => {
    const d = def({ fieldType: 'FILE' });
    expect(validateFieldValue(d, '  /srv/a.mp4  ')).toEqual({ ok: true, value: '/srv/a.mp4' });
    expect(validateFieldValue(d, '   ')).toEqual({ ok: true, value: null });
  });
});

describe('validateFieldValue — IMAGE', () => {
  const tinyImage = 'data:image/webp;base64,UklGRhoAAABXRUJQ';

  it('accepts a bounded image data URL', () => {
    const d = def({ fieldType: 'IMAGE' });
    expect(validateFieldValue(d, tinyImage)).toEqual({ ok: true, value: tinyImage });
  });

  it('rejects a value that is not an image data URL, naming the field', () => {
    const d = def({ fieldType: 'IMAGE', name: 'Cover art' });
    for (const bad of ['https://x.test/a.png', 'data:text/plain;base64,YQ==', 'just text']) {
      expect(validateFieldValue(d, bad)).toEqual({ ok: false, error: 'Cover art must be an image.' });
    }
  });

  it('rejects an oversized image, naming the field', () => {
    const d = def({ fieldType: 'IMAGE', name: 'Cover art' });
    const huge = `data:image/webp;base64,${'A'.repeat(1_000_000)}`;
    expect(validateFieldValue(d, huge)).toEqual({ ok: false, error: 'Cover art image is too large.' });
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
