import { describe, expect, it } from 'vitest';
import { normaliseIsoDate } from './normalise';
import { DbError } from '../../errors';

describe('normaliseIsoDate', () => {
  it('returns null for null/undefined/blank', () => {
    expect(normaliseIsoDate(null)).toBeNull();
    expect(normaliseIsoDate(undefined)).toBeNull();
    expect(normaliseIsoDate('')).toBeNull();
    expect(normaliseIsoDate('   ')).toBeNull();
  });

  it('passes a canonical YYYY-MM-DD through unchanged (trimming surrounding space)', () => {
    expect(normaliseIsoDate('2026-07-20')).toBe('2026-07-20');
    expect(normaliseIsoDate('  2024-06-15  ')).toBe('2024-06-15');
  });

  it('preserves the exact calendar day regardless of the runtime timezone (#327)', () => {
    // The old Date.parse → toISOString round-trip shifted local-parsed values back a day in
    // UTC-positive zones. A bare ISO date must store the day the user wrote, byte-for-byte.
    for (const iso of ['2026-01-01', '2026-12-31', '2026-07-20']) {
      expect(normaliseIsoDate(iso)).toBe(iso);
    }
  });

  it('rejects a non-ISO date rather than silently coercing it (#327)', () => {
    // These are exactly the values Date.parse would have read as *local* time and shifted a
    // day; rejecting them means a future import path can never inherit the silent shift.
    for (const bad of ['2026/07/20', '20 Jul 2026', '07-20-2026', 'tomorrow', '2026-7-20']) {
      expect(() => normaliseIsoDate(bad)).toThrow(DbError);
    }
  });

  it('rejects an out-of-range calendar date', () => {
    for (const bad of ['2026-13-01', '2026-00-10', '2026-02-30', '2026-04-31', '2026-01-32']) {
      expect(() => normaliseIsoDate(bad)).toThrow(DbError);
    }
  });
});
