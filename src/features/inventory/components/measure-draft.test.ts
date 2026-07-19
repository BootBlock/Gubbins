import { describe, expect, it } from 'vitest';
import { parseOptionalNumber, resolveMeasureDraft } from './measure-draft';

/** Stand-in for a grams↔kg style conversion, so the canonical value is visibly different. */
const toCanonical = (entered: number) => entered * 1000;
const toInput = (stored: number | null) => (stored == null ? '' : String(stored / 1000));

describe('parseOptionalNumber', () => {
  it('treats a blank entry as a deliberate clear', () => {
    expect(parseOptionalNumber('')).toEqual({ value: null, issue: null });
    expect(parseOptionalNumber('   ')).toEqual({ value: null, issue: null });
  });

  it('accepts a non-negative number', () => {
    expect(parseOptionalNumber('0')).toEqual({ value: 0, issue: null });
    expect(parseOptionalNumber('12.5')).toEqual({ value: 12.5, issue: null });
  });

  it('reports a negative entry rather than silently clearing it', () => {
    expect(parseOptionalNumber('-5')).toEqual({ value: null, issue: 'negative' });
  });

  it('reports an unparseable entry', () => {
    expect(parseOptionalNumber('abc')).toEqual({ value: null, issue: 'not-a-number' });
    expect(parseOptionalNumber('1e')).toEqual({ value: null, issue: 'not-a-number' });
  });
});

describe('resolveMeasureDraft', () => {
  it('keeps the exact stored value when the field is untouched', () => {
    // 500 canonical displays as "0.5"; an untouched field must not round-trip it.
    expect(resolveMeasureDraft('0.5', 500, toCanonical, toInput)).toEqual({
      dirty: false,
      value: 500,
      issue: null,
    });
  });

  it('re-derives the canonical value from an edited entry', () => {
    expect(resolveMeasureDraft('2', 500, toCanonical, toInput)).toEqual({
      dirty: true,
      value: 2000,
      issue: null,
    });
  });

  it('clears the stored value when the entry is blanked', () => {
    expect(resolveMeasureDraft('', 500, toCanonical, toInput)).toEqual({
      dirty: true,
      value: null,
      issue: null,
    });
  });

  it('keeps the stored value and reports the issue for a negative entry (issue #345)', () => {
    expect(resolveMeasureDraft('-5', 500, toCanonical, toInput)).toEqual({
      dirty: true,
      value: 500,
      issue: 'negative',
    });
  });

  it('keeps the stored value and reports the issue for an unparseable entry', () => {
    expect(resolveMeasureDraft('abc', 500, toCanonical, toInput)).toEqual({
      dirty: true,
      value: 500,
      issue: 'not-a-number',
    });
  });

  it('treats an unset stored value as null when untouched', () => {
    expect(resolveMeasureDraft('', null, toCanonical, toInput)).toEqual({
      dirty: false,
      value: null,
      issue: null,
    });
  });
});
