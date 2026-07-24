/**
 * Calendar feed tests (EI-2) over a hydrated SYNTHETIC snapshot (no real or personal data).
 *
 * The fixture carries one of each time-bearing fact: an open loan with a due date (plus a
 * no-due-date and a returned checkout that must NOT appear), an active asset booking (plus a
 * cancelled one that must not appear), a TIME maintenance schedule (plus a USAGE one that has
 * no calendar date and must be skipped), and three items with a warranty date. Every assertion
 * derives its expected date from the emitter helpers, so the test is timezone-independent.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { buildCalendar, buildCalendarEvents } from './feed.ts';
import { icalDate, icalDateFromIso, icalLocalDate, type VEvent } from './emitter.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-calendar-snapshot.json', import.meta.url);

/** A fixed "now" so the date-derived reads are deterministic (well before every fixture date). */
const NOW = 1752000000000; // 2025-07-08T…Z
const DTSTAMP = 1751000000000; // the fixture's generatedAt

let hydrated: HydrateResult;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});

afterAll(async () => {
  await hydrated.driver.close();
});

function events(types?: readonly ('loans' | 'bookings' | 'maintenance' | 'warranty')[]): Promise<VEvent[]> {
  return buildCalendarEvents(hydrated.driver, { dtstamp: DTSTAMP, now: NOW, ...(types ? { types } : {}) });
}

function byUid(list: readonly VEvent[], uid: string): VEvent | undefined {
  return list.find((e) => e.uid === uid);
}

describe('loan due-backs', () => {
  it('emits an all-day event only for an open checkout WITH a due date', async () => {
    const loans = await events(['loans']);
    expect(loans).toHaveLength(1);
    const loan = loans[0]!;
    expect(loan.uid).toBe('loan-checkout-open-due@gubbins.invalid');
    expect(loan.summary).toBe('Loan due: Multimeter');
    expect(loan.start).toEqual(icalDate(1754006400000));
    // All-day → exclusive next-day end.
    expect(loan.end).toEqual(icalDate(1754006400000 + 86400000));
    expect(loan.description).toContain('Alex Rivera');
    expect(loan.categories).toEqual(['Gubbins', 'Loan']);
  });

  it('excludes returned loans and open loans with no due date', async () => {
    const uids = (await events(['loans'])).map((e) => e.uid);
    expect(uids).not.toContain('loan-checkout-open-nodue@gubbins.invalid');
    expect(uids).not.toContain('loan-checkout-returned@gubbins.invalid');
  });
});

describe('asset bookings', () => {
  it('emits an all-day span for an active booking and excludes a cancelled one', async () => {
    const bookings = await events(['bookings']);
    expect(bookings).toHaveLength(1);
    const booking = bookings[0]!;
    expect(booking.uid).toBe('booking-booking-active@gubbins.invalid');
    expect(booking.summary).toBe('Booking: Cordless Drill');
    expect(booking.start).toEqual(icalDate(2064268800000));
    expect(booking.end).toEqual(icalDate(2064441600000 + 86400000)); // exclusive last-day+1
    expect(booking.description).toContain('Sam Okoro');
    expect(booking.categories).toEqual(['Gubbins', 'Booking']);
  });
});

describe('maintenance', () => {
  it('emits a TIME schedule on its computed due date and skips a USAGE schedule', async () => {
    const maint = await events(['maintenance']);
    expect(maint).toHaveLength(1);
    const service = maint[0]!;
    expect(service.uid).toBe('maintenance-sched-time-drill@gubbins.invalid');
    expect(service.summary).toBe('Maintenance due: Chuck lubrication — Cordless Drill');
    // last_performed_at + interval_days·86_400_000, read as its LOCAL calendar day (issue #321).
    expect(service.start).toEqual(icalLocalDate(1748000000000 + 90 * 86400000));
    expect(service.categories).toEqual(['Gubbins', 'Maintenance']);
  });
});

describe('warranty', () => {
  it('emits an all-day event per item with a warranty date, using the stored date verbatim', async () => {
    const warranties = await events(['warranty']);
    const drill = byUid(warranties, 'warranty-item-drill@gubbins.invalid');
    expect(drill?.summary).toBe('Warranty expires: Cordless Drill');
    expect(drill?.start).toEqual(icalDateFromIso('2027-03-15'));
    expect(byUid(warranties, 'warranty-item-multimeter@gubbins.invalid')?.start).toEqual(
      icalDateFromIso('2026-11-01'),
    );
    expect(byUid(warranties, 'warranty-item-label-printer@gubbins.invalid')).toBeDefined();
  });
});

describe('the whole feed', () => {
  it('combines every source and yields globally-unique, stable UIDs', async () => {
    const all = await events();
    const uids = all.map((e) => e.uid);
    expect(new Set(uids).size).toBe(uids.length);
    // Re-running over the same snapshot yields identical UIDs (stable across refetches).
    const again = await events();
    expect(again.map((e) => e.uid)).toEqual(uids);
  });

  it('honours the type filter (a subset selects only those sources)', async () => {
    const subset = await events(['loans', 'warranty']);
    const kinds = new Set(subset.map((e) => e.uid.split('-')[0]));
    expect(kinds).toEqual(new Set(['loan', 'warranty']));
  });

  it('renders a valid VCALENDAR document via buildCalendar', async () => {
    const ics = await buildCalendar(hydrated.driver, { dtstamp: DTSTAMP, now: NOW });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('UID:loan-checkout-open-due@gubbins.invalid\r\n');
    expect(ics).toContain('DTSTAMP:20250627T045320Z\r\n');
  });
});

describe('empty calendar', () => {
  it('yields a valid, event-free VCALENDAR when a source has no data', async () => {
    // Filter to a source the fixture cannot exercise the wrong way: an empty-DB style check by
    // asking for only bookings after cancelling — simplest is a fresh empty snapshot.
    const empty = await hydrateFromJson(
      JSON.stringify({
        formatVersion: 1,
        generatedAt: DTSTAMP,
        tables: {
          locations: [],
          categories: [],
          items: [],
          item_stock: [],
          stock_batches: [],
          capabilities: [],
        },
        tombstones: [],
        gaugeHistory: [],
        itemTags: [],
        itemHistory: [],
      }),
    );
    try {
      const ics = await buildCalendar(empty.driver, { dtstamp: DTSTAMP, now: NOW });
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('END:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    } finally {
      await empty.driver.close();
    }
  });
});
