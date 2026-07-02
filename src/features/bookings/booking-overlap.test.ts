import { describe, it, expect } from 'vitest';

import { MS_PER_DAY } from '@/db/repositories/constants';
import {
  startOfLocalDay,
  normaliseDayRange,
  rangesOverlap,
  findFirstOverlap,
  type DayRange,
  type OverlapCandidate,
} from './booking-overlap';

// A fixed, timezone-robust day-start anchor. We never hard-code raw day-boundary ms
// literals — every instant is derived from this base plus whole-day offsets, so the
// suite passes regardless of the machine's local timezone.
const DAY0 = startOfLocalDay(Date.UTC(2026, 0, 15, 12));

/** Day-start instant `n` whole days after the anchor (negative ⇒ before). */
const day = (n: number): number => DAY0 + n * MS_PER_DAY;

/** A whole-day instant offset from `day(n)` by `frac` of a day (for "mid-day" times). */
const within = (n: number, frac: number): number => day(n) + Math.round(frac * MS_PER_DAY);

describe('startOfLocalDay', () => {
  it('is idempotent — snapping an already-snapped instant is a no-op', () => {
    expect(startOfLocalDay(DAY0)).toBe(DAY0);
    expect(startOfLocalDay(startOfLocalDay(DAY0))).toBe(DAY0);
  });

  it('snaps any instant within a local day to that day-start', () => {
    expect(startOfLocalDay(within(0, 0.5))).toBe(DAY0);
    expect(startOfLocalDay(within(0, 0.999))).toBe(DAY0);
  });

  it('maps two distinct instants on the same local day to the same day-start', () => {
    const morning = within(3, 0.1);
    const evening = within(3, 0.9);
    expect(morning).not.toBe(evening);
    expect(startOfLocalDay(morning)).toBe(startOfLocalDay(evening));
    expect(startOfLocalDay(morning)).toBe(day(3));
  });

  it('keeps different days distinct', () => {
    expect(startOfLocalDay(day(3))).not.toBe(startOfLocalDay(day(4)));
  });
});

describe('normaliseDayRange', () => {
  it('snaps both ends to their local day-start', () => {
    const range = normaliseDayRange(within(2, 0.3), within(5, 0.8));
    expect(range).toEqual<DayRange>({ start: day(2), end: day(5) });
  });

  it('accepts an already day-start pair unchanged', () => {
    expect(normaliseDayRange(day(2), day(5))).toEqual<DayRange>({ start: day(2), end: day(5) });
  });

  it('produces an inclusive single-day range when both ends are the same day', () => {
    const range = normaliseDayRange(within(4, 0.1), within(4, 0.9));
    expect(range).toEqual<DayRange>({ start: day(4), end: day(4) });
  });

  it('swaps the ends when the snapped end is before the snapped start', () => {
    const range = normaliseDayRange(within(7, 0.2), within(2, 0.6));
    expect(range).toEqual<DayRange>({ start: day(2), end: day(7) });
    expect(range.end).toBeGreaterThanOrEqual(range.start);
  });

  it('throws a RangeError when the start is NaN', () => {
    expect(() => normaliseDayRange(Number.NaN, day(1))).toThrow(RangeError);
    expect(() => normaliseDayRange(Number.NaN, day(1))).toThrow('A booking needs valid start and end dates.');
  });

  it('throws a RangeError when the end is NaN', () => {
    expect(() => normaliseDayRange(day(1), Number.NaN)).toThrow(RangeError);
  });

  it('throws a RangeError on positive or negative Infinity', () => {
    expect(() => normaliseDayRange(Number.POSITIVE_INFINITY, day(1))).toThrow(RangeError);
    expect(() => normaliseDayRange(day(1), Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('rangesOverlap', () => {
  it('treats identical ranges as overlapping', () => {
    expect(rangesOverlap(day(2), day(5), day(2), day(5))).toBe(true);
  });

  it('treats a fully nested range as overlapping', () => {
    expect(rangesOverlap(day(1), day(9), day(3), day(5))).toBe(true);
    expect(rangesOverlap(day(3), day(5), day(1), day(9))).toBe(true);
  });

  it('detects a partial overlap at either end', () => {
    expect(rangesOverlap(day(2), day(5), day(4), day(8))).toBe(true);
    expect(rangesOverlap(day(4), day(8), day(2), day(5))).toBe(true);
  });

  it('does NOT treat adjacent days as overlapping (a ends day 3, b starts day 4)', () => {
    expect(rangesOverlap(day(1), day(3), day(4), day(6))).toBe(false);
    expect(rangesOverlap(day(4), day(6), day(1), day(3))).toBe(false);
  });

  it('treats a same-day touch as a clash (a ends day 4, b starts day 4)', () => {
    expect(rangesOverlap(day(1), day(4), day(4), day(6))).toBe(true);
    expect(rangesOverlap(day(4), day(6), day(1), day(4))).toBe(true);
  });

  it('returns false for fully disjoint ranges', () => {
    expect(rangesOverlap(day(1), day(2), day(10), day(12))).toBe(false);
  });

  it('handles single-day ranges — same day clashes, neighbouring days do not', () => {
    expect(rangesOverlap(day(5), day(5), day(5), day(5))).toBe(true);
    expect(rangesOverlap(day(5), day(5), day(6), day(6))).toBe(false);
    expect(rangesOverlap(day(5), day(5), day(2), day(7))).toBe(true);
  });
});

describe('findFirstOverlap', () => {
  const candidate: DayRange = { start: day(4), end: day(6) };

  it('returns the first clashing booking in input order', () => {
    const existing: OverlapCandidate[] = [
      { id: 'a', start: day(0), end: day(2) }, // disjoint
      { id: 'b', start: day(5), end: day(8) }, // first clash
      { id: 'c', start: day(4), end: day(4) }, // also clashes, but later
    ];
    expect(findFirstOverlap(candidate, existing)?.id).toBe('b');
  });

  it('returns null when nothing clashes', () => {
    const existing: OverlapCandidate[] = [
      { id: 'a', start: day(0), end: day(3) }, // adjacent, no overlap
      { id: 'b', start: day(7), end: day(9) }, // disjoint after
    ];
    expect(findFirstOverlap(candidate, existing)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(findFirstOverlap(candidate, [])).toBeNull();
  });
});
