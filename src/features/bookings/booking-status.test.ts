import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '@/db/repositories/constants';

import {
  BOOKING_STATUSES,
  BOOKING_STATUS_BADGE,
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  type BookingStatusInput,
  deriveBookingStatus,
  isBookableTrackingMode,
} from './booking-status';

// Timezone-robust anchor: start of the local day containing noon on 2026-01-15 UTC. Deriving
// every instant from this same local-midnight base means the boundary tests hold in any host
// time zone (the seam itself uses local-midnight day boundaries).
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const DAY0 = startOfLocalDay(Date.UTC(2026, 0, 15, 12));
const day = (n: number): number => DAY0 + n * MS_PER_DAY;

/** A plain, not-cancelled, not-converted booking over days [start, end] (in `day()` units). */
function booking(startN: number, endN: number): BookingStatusInput {
  return {
    startDate: day(startN),
    endDate: day(endN),
    cancelledAt: null,
    convertedCheckoutId: null,
  };
}

describe('deriveBookingStatus — stored-state precedence', () => {
  it('cancelled beats converted and dates', () => {
    const b: BookingStatusInput = {
      startDate: day(0),
      endDate: day(2),
      cancelledAt: day(1),
      convertedCheckoutId: 'co-1',
    };
    // now is mid-window (would otherwise be 'active') and it is also converted — cancelled wins.
    expect(deriveBookingStatus(b, day(1))).toBe('cancelled');
  });

  it('converted beats dates (mid-window)', () => {
    const b: BookingStatusInput = { ...booking(0, 2), convertedCheckoutId: 'co-1' };
    expect(deriveBookingStatus(b, day(1))).toBe('converted');
  });

  it('converted beats dates (window passed — would otherwise be overdue)', () => {
    const b: BookingStatusInput = { ...booking(0, 2), convertedCheckoutId: 'co-1' };
    expect(deriveBookingStatus(b, day(10))).toBe('converted');
  });
});

describe('deriveBookingStatus — date-based branches', () => {
  it('upcoming before the window starts', () => {
    expect(deriveBookingStatus(booking(5, 7), day(0))).toBe('upcoming');
  });

  it('active within the window', () => {
    expect(deriveBookingStatus(booking(0, 4), day(2))).toBe('active');
  });

  it('overdue after the window fully passes', () => {
    expect(deriveBookingStatus(booking(0, 2), day(5))).toBe('overdue');
  });
});

describe('deriveBookingStatus — exact boundary instants', () => {
  it('now === startDate → active (inclusive start)', () => {
    const b = booking(3, 5);
    expect(deriveBookingStatus(b, day(3))).toBe('active');
  });

  it('one ms before startDate → upcoming', () => {
    const b = booking(3, 5);
    expect(deriveBookingStatus(b, day(3) - 1)).toBe('upcoming');
  });

  it('last ms of the end day → active (whole end day is booked)', () => {
    const b = booking(0, 2);
    // endExclusive = startOfLocalDay(endDate) + MS_PER_DAY === day(3); last ms is one before.
    expect(deriveBookingStatus(b, day(3) - 1)).toBe('active');
  });

  it('now === endExclusive (start of the day AFTER endDate) → overdue', () => {
    const b = booking(0, 2);
    expect(deriveBookingStatus(b, day(3))).toBe('overdue');
  });

  it('single-day booking is active for that whole day', () => {
    const b = booking(4, 4);
    expect(deriveBookingStatus(b, day(4))).toBe('active');
    expect(deriveBookingStatus(b, day(5) - 1)).toBe('active');
    expect(deriveBookingStatus(b, day(5))).toBe('overdue');
    expect(deriveBookingStatus(b, day(4) - 1)).toBe('upcoming');
  });
});

describe('isBookableTrackingMode', () => {
  it('SERIALISED is always bookable, regardless of quantity', () => {
    expect(isBookableTrackingMode('SERIALISED', 1)).toBe(true);
    expect(isBookableTrackingMode('SERIALISED', 5)).toBe(true);
  });

  it('DISCRETE is bookable only as a single unit', () => {
    expect(isBookableTrackingMode('DISCRETE', 1)).toBe(true);
    expect(isBookableTrackingMode('DISCRETE', 2)).toBe(false);
    expect(isBookableTrackingMode('DISCRETE', 0)).toBe(false);
  });

  it('CONSUMABLE_GAUGE is never bookable', () => {
    expect(isBookableTrackingMode('CONSUMABLE_GAUGE', 1)).toBe(false);
  });

  it('unknown modes are not bookable', () => {
    expect(isBookableTrackingMode('MYSTERY', 1)).toBe(false);
    expect(isBookableTrackingMode('', 1)).toBe(false);
  });
});

describe('display metadata', () => {
  it('exposes a label, tone and badge for every status', () => {
    for (const status of BOOKING_STATUSES) {
      expect(BOOKING_STATUS_LABEL[status]).toBeTruthy();
      expect(BOOKING_STATUS_TONE[status]).toBeTruthy();
      expect(BOOKING_STATUS_BADGE[status]).toBeTruthy();
    }
  });

  it('lists the open states first in display order', () => {
    expect(BOOKING_STATUSES).toEqual([
      'upcoming',
      'active',
      'overdue',
      'converted',
      'cancelled',
    ]);
  });

  it('uses British-English labels', () => {
    expect(BOOKING_STATUS_LABEL.cancelled).toBe('Cancelled');
    expect(BOOKING_STATUS_LABEL.converted).toBe('Checked out');
    expect(BOOKING_STATUS_LABEL.overdue).toBe('Overdue');
    expect(BOOKING_STATUS_LABEL.active).toBe('In use');
    expect(BOOKING_STATUS_LABEL.upcoming).toBe('Upcoming');
  });

  it('uses design tokens, not raw colour literals', () => {
    const classes = [
      ...Object.values(BOOKING_STATUS_TONE),
      ...Object.values(BOOKING_STATUS_BADGE),
    ].join(' ');
    // No Tailwind palette classes (e.g. text-red-500, bg-blue-600) and no raw hex.
    expect(classes).not.toMatch(/(?:text|bg)-(?:red|blue|green|amber|zinc|gray|slate)-\d/);
    expect(classes).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
