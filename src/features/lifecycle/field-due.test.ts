/**
 * Custom-field due-date maths (W1a) — the pure seam that decides whether a user-defined `DATE`
 * is scheduled, due soon or overdue.
 *
 * The comparisons are **calendar-day** ones against a stored midnight-UTC day, so the cases that
 * matter are the boundaries: the day itself, the far edge of the lead time, and the moment a
 * deadline tips into overdue. Every one is pinned here rather than left to the SQL that narrows
 * the read — the query and this classifier have to agree day-for-day, and only one of them can
 * be tested cheaply.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_DUE_LEAD_DAYS_MAX, FIELD_DUE_LEAD_DAYS_MIN, MS_PER_DAY } from '@/db/repositories/constants';
import { startOfLocalDay } from '@/lib/calendar-days';
import { clampFieldDueLeadDays, fieldDueStatus } from './field-due';

/** Mid-afternoon on a fixed day, so "today" is unambiguous and nothing sits on a midnight. */
const NOW = startOfLocalDay(Date.parse('2026-06-30T12:00:00Z')) + 15 * 60 * 60 * 1000;

/** The midnight-UTC instant of the calendar day `offset` days from today, as stored. */
function storedDay(offset: number): number {
  const today = new Date(startOfLocalDay(NOW));
  return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset);
}

describe('fieldDueStatus', () => {
  it('says NONE when no date is recorded, so an empty field raises nothing', () => {
    expect(fieldDueStatus(null, 14, NOW)).toBe('NONE');
    expect(fieldDueStatus(undefined, 14, NOW)).toBe('NONE');
  });

  it('is DUE_SOON on the day itself, all day, whatever the hour', () => {
    const startOfToday = startOfLocalDay(NOW);
    expect(fieldDueStatus(storedDay(0), 14, startOfToday)).toBe('DUE_SOON');
    expect(fieldDueStatus(storedDay(0), 14, startOfToday + MS_PER_DAY - 1)).toBe('DUE_SOON');
  });

  it('only turns OVERDUE once the day has fully passed — never the evening before', () => {
    expect(fieldDueStatus(storedDay(-1), 14, NOW)).toBe('OVERDUE');
    expect(fieldDueStatus(storedDay(0), 14, NOW)).toBe('DUE_SOON');
  });

  it('includes the far edge of the lead time and excludes the day past it', () => {
    expect(fieldDueStatus(storedDay(14), 14, NOW)).toBe('DUE_SOON');
    expect(fieldDueStatus(storedDay(15), 14, NOW)).toBe('SCHEDULED');
  });

  it('treats a lead time of 0 as "tell me on the day", not "never"', () => {
    expect(fieldDueStatus(storedDay(0), 0, NOW)).toBe('DUE_SOON');
    expect(fieldDueStatus(storedDay(1), 0, NOW)).toBe('SCHEDULED');
    expect(fieldDueStatus(storedDay(-1), 0, NOW)).toBe('OVERDUE');
  });

  it('reports a past date as OVERDUE regardless of the lead time', () => {
    // A deadline that has already gone is the one most worth raising, so no lead time hides it.
    expect(fieldDueStatus(storedDay(-400), 0, NOW)).toBe('OVERDUE');
    expect(fieldDueStatus(storedDay(-400), 365, NOW)).toBe('OVERDUE');
  });

  it('clamps an out-of-range lead time rather than widening the window without limit', () => {
    // A value beyond the schema's CHECK could only arrive from a hand-edited or foreign row;
    // it must not silently behave as "alert on everything, forever".
    expect(fieldDueStatus(storedDay(400), 10_000, NOW)).toBe('SCHEDULED');
    expect(fieldDueStatus(storedDay(365), 10_000, NOW)).toBe('DUE_SOON');
  });
});

describe('clampFieldDueLeadDays', () => {
  it('keeps a value already in range', () => {
    expect(clampFieldDueLeadDays(14)).toBe(14);
    expect(clampFieldDueLeadDays(FIELD_DUE_LEAD_DAYS_MIN)).toBe(FIELD_DUE_LEAD_DAYS_MIN);
    expect(clampFieldDueLeadDays(FIELD_DUE_LEAD_DAYS_MAX)).toBe(FIELD_DUE_LEAD_DAYS_MAX);
  });

  it('pulls an out-of-range value to the nearest bound', () => {
    expect(clampFieldDueLeadDays(-5)).toBe(FIELD_DUE_LEAD_DAYS_MIN);
    expect(clampFieldDueLeadDays(9999)).toBe(FIELD_DUE_LEAD_DAYS_MAX);
  });

  it('rounds a fractional value — a lead time is a whole number of days', () => {
    expect(clampFieldDueLeadDays(14.4)).toBe(14);
    expect(clampFieldDueLeadDays(14.6)).toBe(15);
  });

  it('falls back to the minimum for a non-number, so an empty input cannot store NaN', () => {
    expect(clampFieldDueLeadDays(Number.NaN)).toBe(FIELD_DUE_LEAD_DAYS_MIN);
    expect(clampFieldDueLeadDays(Number.POSITIVE_INFINITY)).toBe(FIELD_DUE_LEAD_DAYS_MIN);
  });
});
