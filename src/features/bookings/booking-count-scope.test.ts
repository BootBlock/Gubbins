/**
 * The scope → `BookingCountFilter` mapping behind the Dashboard's Bookings tile (issue #573).
 *
 * The tile used to filter a page of loaded rows, so the "upcoming" cut-off and the seven-day
 * window were asserted against that selector. They now live here, on the way into a `COUNT(*)`,
 * and this is where the day arithmetic is pinned: bookings store midnight-UTC day starts
 * (issue #320), so both bounds are taken in UTC and the far edge of the week is exclusive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories';
import { bookingCountFilter } from './bookings';

/** A fixed instant late in a UTC day, so a naive local-time cut-off would land on the wrong day. */
const NOW = Date.UTC(2026, 5, 10, 23, 30, 0);
const TODAY = Date.UTC(2026, 5, 10);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bookingCountFilter', () => {
  it('counts every booking for "all" — no bound at all, terminal ones included', () => {
    expect(bookingCountFilter('all')).toEqual({});
  });

  it('keeps a booking upcoming through the whole of its last booked day', () => {
    // The cut-off is the *start* of today, so an all-day booking ending today still counts.
    expect(bookingCountFilter('upcoming')).toEqual({ liveOnly: true, endsOnOrAfter: TODAY });
  });

  it('takes the week as seven UTC days from the start of today, far edge exclusive', () => {
    expect(bookingCountFilter('startingThisWeek')).toEqual({
      liveOnly: true,
      startsFrom: TODAY,
      startsBefore: TODAY + 7 * MS_PER_DAY,
    });
  });
});
