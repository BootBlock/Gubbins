/**
 * The date-input seam is what stops two screens disagreeing about which instant a calendar day
 * means. These tests pin the midnight-UTC convention, the exact round-trip, and — via the
 * re-export the inventory editors import — that every date field in the app resolves a given
 * day to the *same* instant, so the spend and valuation-trend reports bucket them together.
 */
import { describe, expect, it } from 'vitest';
import {
  fromDateInputValue,
  fromDueDateInputValue,
  toDateInputValue,
  toDueDateInputValue,
  todayDateInputValue,
} from './date-input';
import {
  fromDateInputValue as inventoryFrom,
  toDateInputValue as inventoryTo,
} from '@/features/inventory/components/inventory-ui';

describe('fromDateInputValue', () => {
  it('resolves a calendar day to midnight UTC', () => {
    expect(fromDateInputValue('2026-03-14')).toBe(Date.UTC(2026, 2, 14));
  });

  it('returns null for blank or whitespace-only input', () => {
    expect(fromDateInputValue('')).toBeNull();
    expect(fromDateInputValue('   ')).toBeNull();
  });

  it('returns null for an unparseable value', () => {
    expect(fromDateInputValue('not-a-date')).toBeNull();
  });
});

describe('toDateInputValue', () => {
  it('renders an instant as its UTC calendar day', () => {
    expect(toDateInputValue(Date.UTC(2026, 2, 14))).toBe('2026-03-14');
  });

  it('renders null as blank, so an empty date input stays empty', () => {
    expect(toDateInputValue(null)).toBe('');
  });

  it('round-trips a day entered in a date input', () => {
    const day = '2026-12-31';
    expect(toDateInputValue(fromDateInputValue(day))).toBe(day);
  });
});

describe('todayDateInputValue', () => {
  it('answers with the local calendar day, not the UTC one', () => {
    // The distinction only shows up when the two disagree, which they do near either midnight.
    const instant = new Date(2026, 5, 1, 9, 30).getTime();
    expect(todayDateInputValue(instant)).toBe('2026-06-01');
  });

  it('zero-pads month and day so the value is a valid date input', () => {
    expect(todayDateInputValue(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });

  it('defaults to now', () => {
    expect(todayDateInputValue()).toBe(todayDateInputValue(Date.now()));
  });
});

describe('due-date convention (local calendar day)', () => {
  // Deliberately local, unlike the midnight-UTC pair above: a loan due "on the 20th" should read
  // as the 20th and only count as overdue once that local day is over (issue #318).
  it('anchors a picked day at local end-of-day', () => {
    const ms = fromDueDateInputValue('2026-07-20');
    expect(ms).toBe(new Date(2026, 6, 20, 23, 59, 59).getTime());
  });

  it('reads a due-date instant back as its local calendar day', () => {
    const ms = new Date(2026, 6, 20, 23, 59, 59).getTime();
    expect(toDueDateInputValue(ms)).toBe('2026-07-20');
  });

  it('round-trips a day through the input in any host timezone', () => {
    const day = '2026-02-01';
    expect(toDueDateInputValue(fromDueDateInputValue(day))).toBe(day);
  });

  it('treats blank as no due date, and null as an empty field', () => {
    expect(fromDueDateInputValue('')).toBeNull();
    expect(fromDueDateInputValue('   ')).toBeNull();
    expect(toDueDateInputValue(null)).toBe('');
  });
});

describe('one convention across features', () => {
  // Regression guard for #324: `ExpenseDialog` used to carry a private local-midnight copy, so
  // an expense and an item revaluation recorded against the same day landed up to 13 hours
  // apart and could bucket into different report periods.
  it('is the same seam the inventory editors use', () => {
    expect(inventoryFrom).toBe(fromDateInputValue);
    expect(inventoryTo).toBe(toDateInputValue);
  });

  it('resolves a day to the same instant whatever the host timezone', () => {
    // A local-midnight parse would shift with the runner's offset; this one cannot, so a
    // report bucketing an expense beside an acquisition sees a single instant per day.
    const day = '2026-06-01';
    expect(fromDateInputValue(day)).toBe(Date.UTC(2026, 5, 1));
    expect(toDateInputValue(fromDateInputValue(day))).toBe(day);
  });
});
