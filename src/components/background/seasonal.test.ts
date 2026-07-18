import { describe, expect, it } from 'vitest';
import { OCCASIONS, easterSunday, getOccasion, resolveOccasion } from './seasonal';

/** Local-midnight date, so the tests read as calendar days rather than instants. */
function on(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

describe('easterSunday', () => {
  // Published Gregorian Easter dates — the algorithm is only worth having if it matches these.
  it.each([
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2030, 4, 21],
  ])('resolves %i to %i/%i', (year, month, day) => {
    const easter = easterSunday(year);
    expect([easter.getMonth() + 1, easter.getDate()]).toEqual([month, day]);
  });

  it('always lands on a Sunday', () => {
    for (let year = 2020; year <= 2040; year++) expect(easterSunday(year).getDay()).toBe(0);
  });
});

describe('resolveOccasion', () => {
  it('returns null on an ordinary day', () => {
    expect(resolveOccasion(on(2026, 8, 14))).toBeNull();
  });

  it.each([
    ['christmas', on(2026, 12, 10)],
    ['halloween', on(2026, 10, 31)],
    ['valentines', on(2026, 2, 14)],
    ['bonfire', on(2026, 11, 5)],
    ['cats', on(2026, 5, 20)],
    ['celebration', on(2026, 3, 3)],
  ])('picks %s in its window', (id, date) => {
    expect(resolveOccasion(date)?.id).toBe(id);
  });

  it('covers every celebration day', () => {
    for (const [month, day] of [
      [2, 25],
      [3, 3],
      [7, 1],
    ] as const) {
      expect(resolveOccasion(on(2026, month, day))?.id).toBe('celebration');
    }
  });

  it('runs Easter for the week either side of Easter Sunday, and not beyond', () => {
    const easter = easterSunday(2026); // 5 April 2026
    expect(resolveOccasion(easter)?.id).toBe('easter');
    expect(resolveOccasion(on(2026, 3, 29))?.id).toBe('easter'); // −7 days
    expect(resolveOccasion(on(2026, 4, 12))?.id).toBe('easter'); // +7 days
    expect(resolveOccasion(on(2026, 3, 28))).toBeNull();
    expect(resolveOccasion(on(2026, 4, 13))).toBeNull();
  });

  it('lets the more specific New Year window beat the December season it sits inside', () => {
    expect(resolveOccasion(on(2026, 12, 30))?.id).toBe('christmas');
    expect(resolveOccasion(on(2026, 12, 31))?.id).toBe('new-year');
    expect(resolveOccasion(on(2027, 1, 2))?.id).toBe('new-year');
    expect(resolveOccasion(on(2027, 1, 3))).toBeNull();
  });

  it('starts Halloween on the 24th, not before', () => {
    expect(resolveOccasion(on(2026, 10, 23))).toBeNull();
    expect(resolveOccasion(on(2026, 10, 24))?.id).toBe('halloween');
  });

  describe('overrides', () => {
    it('forces an occasion outside its window', () => {
      expect(resolveOccasion(on(2026, 8, 14), { halloween: 'on' })?.id).toBe('halloween');
    });

    it('suppresses an occasion inside its window', () => {
      expect(resolveOccasion(on(2026, 12, 10), { christmas: 'off' })).toBeNull();
    });

    it('falls through a suppressed occasion to the next one that applies', () => {
      expect(resolveOccasion(on(2026, 12, 31), { 'new-year': 'off' })?.id).toBe('christmas');
    });

    it('keeps registry priority when several are forced on', () => {
      expect(resolveOccasion(on(2026, 8, 14), { christmas: 'on', cats: 'on' })?.id).toBe('cats');
    });

    it('treats an absent override as auto', () => {
      expect(resolveOccasion(on(2026, 12, 10), { halloween: 'off' })?.id).toBe('christmas');
    });
  });
});

describe('OCCASIONS registry', () => {
  it('has unique ids', () => {
    expect(new Set(OCCASIONS.map((o) => o.id)).size).toBe(OCCASIONS.length);
  });

  it('gives every occasion at least one emoji to spawn', () => {
    for (const occasion of OCCASIONS) expect(occasion.emoji.length).toBeGreaterThan(0);
  });

  it('looks occasions up by id, and reads an unknown id as absent', () => {
    expect(getOccasion('christmas')?.label).toBe('Christmas');
    expect(getOccasion('not-a-real-occasion')).toBeUndefined();
  });
});
