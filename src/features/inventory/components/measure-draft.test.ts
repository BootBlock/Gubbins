import { describe, expect, it } from 'vitest';
import { EN_CATALOG, type MessageKey } from '@/features/i18n';
import {
  measureIssueText,
  parseOptionalNumber,
  parseOptionalPositiveInt,
  resolveMeasureDraft,
} from './measure-draft';

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

  it('reports a comma-grouped or comma-decimal figure rather than clearing (issue #675)', () => {
    // How the price is written on the invoice being copied from — `Number()` yields NaN, and the
    // old "finite ? n : null" guard turned that into "erase the stored price".
    expect(parseOptionalNumber('1,250')).toEqual({ value: null, issue: 'not-a-number' });
    expect(parseOptionalNumber('250,00')).toEqual({ value: null, issue: 'not-a-number' });
  });
});

describe('parseOptionalPositiveInt', () => {
  it('treats a blank entry as a deliberate clear', () => {
    expect(parseOptionalPositiveInt('')).toEqual({ value: null, issue: null });
    expect(parseOptionalPositiveInt('  ')).toEqual({ value: null, issue: null });
  });

  it('accepts a whole count above zero, truncating a fraction like the repository', () => {
    expect(parseOptionalPositiveInt('36')).toEqual({ value: 36, issue: null });
    expect(parseOptionalPositiveInt('18.9')).toEqual({ value: 18, issue: null });
  });

  it('reports zero and anything truncating to it, rather than switching the term off (#675)', () => {
    expect(parseOptionalPositiveInt('0')).toEqual({ value: null, issue: 'not-positive' });
    expect(parseOptionalPositiveInt('0.5')).toEqual({ value: null, issue: 'not-positive' });
    expect(parseOptionalPositiveInt('-12')).toEqual({ value: null, issue: 'not-positive' });
  });

  it('reports an unparseable entry', () => {
    expect(parseOptionalPositiveInt('abc')).toEqual({ value: null, issue: 'not-a-number' });
    expect(parseOptionalPositiveInt('1,250')).toEqual({ value: null, issue: 'not-a-number' });
  });
});

describe('measureIssueText', () => {
  /** Stands in for `useT`, resolving against the real English catalog. */
  const t = (key: MessageKey) => (EN_CATALOG as Record<string, string>)[key] ?? key;

  it('says nothing for an entry with no issue', () => {
    expect(measureIssueText(null, t)).toBeUndefined();
  });

  it('explains every issue kind, so no rejected entry renders a blank error', () => {
    // The exhaustive `default:` guard is compile-time only — this pins that each variant
    // actually resolves to real copy rather than falling through to its own key name.
    for (const issue of ['negative', 'not-positive', 'not-a-number'] as const) {
      const text = measureIssueText(issue, t);
      expect(text).toBeTruthy();
      expect(text).not.toContain('inventory.details.');
    }
  });

  it('names zero-or-below separately from merely negative', () => {
    expect(measureIssueText('not-positive', t)).not.toBe(measureIssueText('negative', t));
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
