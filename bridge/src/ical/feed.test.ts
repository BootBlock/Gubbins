/**
 * Calendar feed tests (EI-2) over a hydrated SYNTHETIC snapshot (no real or personal data).
 *
 * The fixture carries one of each time-bearing fact: an open loan with a due date (plus a
 * no-due-date and a returned checkout that must NOT appear), an active asset booking (plus a
 * cancelled one that must not appear), a TIME maintenance schedule (plus a USAGE one that has
 * no calendar date and must be skipped), and three items with a warranty date. Every assertion
 * derives its expected date from the emitter helpers, so the test is timezone-independent.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { buildCalendar, buildCalendarEvents } from './feed.ts';
import { addDays, icalDate, icalDateFromIso, icalLocalDate, type VEvent } from './emitter.ts';

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
    // A loan due date is stored at local end-of-day, so it reads as its LOCAL calendar day (#321).
    expect(loan.start).toEqual(icalLocalDate(1754006400000));
    // All-day → exclusive next-day end (a calendar-day step on the DATE value, DST-safe).
    expect(loan.end).toEqual(addDays(icalLocalDate(1754006400000), 1));
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

// ---------------------------------------------------------------------------
// Per-source date frame — proven under a non-UTC zone (issue #321).
//
// The in-worker assertions above compare each event's DTSTART to the *same* emitter helper the
// feed uses, so they only tell `icalLocalDate` apart from `icalDate` when the runner's zone puts a
// value's local day on a different date from its UTC day. Under a UTC (or east-of-UTC) worker they
// agree, so a regression of a source to the wrong helper would slip through. The bridge config
// can't re-seat the zone in its worker-threads pool, so this runs the real feed in a child process
// pinned to America/New_York (UTC-4/-5) — where a midnight-UTC value's local day is the day before
// — reusing the bridge's own `@/`-alias loader (the same mechanism `cli.mjs`/`smoke.mjs` use).
// ---------------------------------------------------------------------------

describe('per-source date frame across a UTC boundary (America/New_York)', () => {
  it('renders a local-eod loan on its local day but a midnight-UTC booking on its UTC day', () => {
    const dir = import.meta.dirname; // bridge/src/ical
    const loaderUrl = pathToFileURL(join(dir, '..', '..', 'loader.mjs')).href;
    const feedUrl = pathToFileURL(join(dir, 'feed.ts')).href;
    const emitterUrl = pathToFileURL(join(dir, 'emitter.ts')).href;
    const hydrateUrl = pathToFileURL(join(dir, '..', 'hydrate.ts')).href;
    const fixturePath = join(dir, '..', 'fixtures', 'synthetic-calendar-snapshot.json');

    // Fixture instants (both are midnight UTC, so New York reads them as the previous day).
    const LOAN_DUE = 1754006400000;
    const BOOKING_START = 2064268800000;

    const script = `
      process.env.TZ = 'America/New_York';
      const { register } = await import('node:module');
      const { readFile } = await import('node:fs/promises');
      register(${JSON.stringify(loaderUrl)});
      const { buildCalendarEvents } = await import(${JSON.stringify(feedUrl)});
      const { icalDate, icalLocalDate } = await import(${JSON.stringify(emitterUrl)});
      const { hydrateFromJson } = await import(${JSON.stringify(hydrateUrl)});
      const { driver } = await hydrateFromJson(await readFile(${JSON.stringify(fixturePath)}, 'utf8'));
      const events = await buildCalendarEvents(driver, { dtstamp: ${DTSTAMP}, now: ${NOW} });
      await driver.close();
      const find = (uid) => events.find((e) => e.uid === uid);
      const loan = find('loan-checkout-open-due@gubbins.invalid');
      const booking = find('booking-booking-active@gubbins.invalid');
      process.stdout.write(JSON.stringify({
        loanStart: loan.start.value,
        loanLocal: icalLocalDate(${LOAN_DUE}).value,
        loanUtc: icalDate(${LOAN_DUE}).value,
        bookingStart: booking.start.value,
        bookingLocal: icalLocalDate(${BOOKING_START}).value,
        bookingUtc: icalDate(${BOOKING_START}).value,
      }));
    `;
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    const r = JSON.parse(out);

    // The pinned zone genuinely separates the local and UTC readings for these instants.
    expect(r.loanLocal).not.toBe(r.loanUtc);
    expect(r.bookingLocal).not.toBe(r.bookingUtc);
    // The loan (local end-of-day) renders on its LOCAL day; a swap back to icalDate would fail here.
    expect(r.loanStart).toBe(r.loanLocal);
    expect(r.loanStart).not.toBe(r.loanUtc);
    // The booking (midnight UTC, #320) renders on its UTC day; using local would be wrong for it.
    expect(r.bookingStart).toBe(r.bookingUtc);
    expect(r.bookingStart).not.toBe(r.bookingLocal);
  });
});
