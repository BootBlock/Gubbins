import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { daysOverdue, overdueLabel } from './overdue';

const NOW = Date.parse('2026-06-30T12:00:00Z');

describe('daysOverdue', () => {
  it('counts whole days past the due date, flooring partial days', () => {
    expect(daysOverdue(NOW - 3 * MS_PER_DAY, NOW)).toBe(3);
    expect(daysOverdue(NOW - MS_PER_DAY, NOW)).toBe(1);
    // Overdue by 23 hours is still under a full day.
    expect(daysOverdue(NOW - 23 * 60 * 60 * 1000, NOW)).toBe(0);
    // Overdue by 25 hours rounds down to a single whole day.
    expect(daysOverdue(NOW - 25 * 60 * 60 * 1000, NOW)).toBe(1);
  });

  it('never returns a negative count for a not-yet-due (or exactly-due) loan', () => {
    expect(daysOverdue(NOW + MS_PER_DAY, NOW)).toBe(0);
    expect(daysOverdue(NOW, NOW)).toBe(0);
  });
});

describe('overdueLabel', () => {
  it('pluralises the day count', () => {
    expect(overdueLabel(1)).toBe('1 day overdue');
    expect(overdueLabel(5)).toBe('5 days overdue');
  });

  it('reads a plain "Overdue" when past due by less than a full day', () => {
    expect(overdueLabel(0)).toBe('Overdue');
  });
});
