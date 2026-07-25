/**
 * The calendar feed projection — EI-2. Turns Gubbins' time-bearing facts into iCalendar
 * `VEVENT`s an app can subscribe to by URL.
 *
 * Four sources, each a **read-only projection through an existing repository** (no bespoke SQL
 * in the bridge — every read is a method the app itself uses):
 *
 *   - **loans**       — open checkouts with a due date (`CheckoutRepository.listOpen`);
 *   - **bookings**    — active asset bookings not yet passed (`AssetBookingRepository.listUpcoming`);
 *   - **maintenance** — TIME-based service schedules and their computed due date
 *                       (`MaintenanceRepository.listUpcoming` + the pure `maintenanceStatus`);
 *   - **warranty**    — items with a warranty-expiry date (`ItemRepository.listWarrantyExpiring`).
 *
 * Each row becomes one VEVENT with a **stable, per-source `UID`** (`<source>-<recordId>@…`), so
 * a subscriber refetching the feed updates the event in place rather than duplicating it. A
 * source with no data simply contributes nothing (a valid, empty calendar is the natural
 * result). USAGE-based maintenance has no calendar date, so it is skipped (it only becomes
 * "due" by usage, not by a date). Every source is bounded ({@link MAX_EVENTS_PER_SOURCE}) so a
 * huge inventory can't produce an unbounded feed.
 *
 * All-day dates dominate here (a due-back, a warranty, a booking span are day-grained). Which
 * calendar components to read depends on how each value is stored (issue #321):
 *
 *   - a **booking** date is stored at midnight UTC (issue #320), so its all-day value uses **UTC**
 *     components — the UTC day is the calendar day the user picked;
 *   - a **loan** due date is stored at local end-of-day and a **maintenance** due date is an
 *     instant carrying the service's local wall-clock time, so both use **local** components (the
 *     bridge runs on the user's own machine, so the local day is the one meant);
 *   - a **warranty**'s stored `YYYY-MM-DD` string is used verbatim (no timezone maths).
 *
 * See `emitter.ts` (`icalDate` vs `icalLocalDate` vs `icalDateFromIso`).
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { CheckoutRepository } from '@/db/repositories/CheckoutRepository.ts';
import { AssetBookingRepository } from '@/db/repositories/AssetBookingRepository.ts';
import { MaintenanceRepository } from '@/db/repositories/MaintenanceRepository.ts';
import { maintenanceStatus, type MaintenanceScheduleState } from '@/features/lifecycle/maintenance.ts';
import { startOfLocalDay, startOfUtcDay } from '@/lib/calendar-days.ts';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type {
  AssetBookingWithNames,
  CheckoutWithNames,
  Item,
  MaintenanceScheduleWithItem,
  Page,
} from '@/db/repositories/types';
import {
  addDays,
  formatCalendar,
  icalDate,
  icalDateFromIso,
  icalLocalDate,
  icalDateTimeUtc,
  type ICalDate,
  type VCalendar,
  type VEvent,
} from './emitter.ts';

/** The four calendar sources, each independently selectable via `?type=`. */
export const CALENDAR_SOURCE_TYPES = ['loans', 'bookings', 'maintenance', 'warranty'] as const;
export type CalendarSourceType = (typeof CALENDAR_SOURCE_TYPES)[number];

/** True when `value` names one of the calendar sources. */
export function isCalendarSourceType(value: string): value is CalendarSourceType {
  return (CALENDAR_SOURCE_TYPES as readonly string[]).includes(value);
}

/** The `PRODID` identifying this emitter (RFC 5545 §3.7.3). */
export const CALENDAR_PRODID = '-//Gubbins//Bridge Calendar//EN';
/** The `X-WR-CALNAME` display hint most calendar clients honour. */
export const CALENDAR_NAME = 'Gubbins';
/**
 * The domain suffix on every event `UID`. Uses the RFC 2606 reserved `.invalid` TLD so a UID
 * can never be mistaken for — or collide with — a real host, and no real domain is committed.
 */
const UID_SUFFIX = '@gubbins.invalid';

/**
 * How far ahead warranty expiries are surfaced. The repository read is window-based
 * (`listWarrantyExpiring(withinDays, now)`), so a generous decade-wide horizon captures every
 * realistic future warranty (and, as that read includes already-past expiries, the historical
 * ones too) while still bounding the query.
 */
const WARRANTY_HORIZON_DAYS = 366 * 10;

/**
 * Per-source hard cap on events. Each source is paged at the repository ceiling and collected
 * up to this many rows — an abuse/memory guard so the feed stays bounded on a very large vault
 * (generous enough never to bite a real personal inventory).
 */
export const MAX_EVENTS_PER_SOURCE = 5_000;

/** Options for building the calendar feed. */
export interface CalendarFeedOptions {
  /**
   * The `DTSTAMP` stamped on every event — the snapshot's generation instant (UNIX-ms), so the
   * output is stable across refetches of the same snapshot and reflects when the data was current.
   */
  readonly dtstamp: number;
  /** "Now" (UNIX-ms) for the date-derived reads (booking cut-off, maintenance due, warranty window). */
  readonly now: number;
  /**
   * Restrict the feed to these sources (the `?type=` selector). Omitted or empty ⇒ all four
   * sources, so the default subscribe URL is the whole calendar.
   */
  readonly types?: readonly CalendarSourceType[];
}

/**
 * When the calendar's representation last changed — the `Last-Modified` (and the basis of the
 * `ETag`) a subscriber revalidates against, issue #363.
 *
 * Unlike the syndication feeds this is **not** a pure function of the snapshot, because two
 * sources read a day-grained cut-off derived from `now`: a booking is kept until the end of its
 * last booked day (a **UTC**-day cut-off — bookings store midnight UTC), and the warranty window
 * is a **local** calendar date. Nothing else here moves with the clock — a TIME schedule's due
 * date is computed from its own anchor (see `maintenanceStatus`), and a projection's row
 * *ordering* is not a semantic difference, which is why the entity-tag is a weak one.
 *
 * So the representation is unchanged since the latest of the snapshot's generation and those two
 * day rollovers, and a subscription can never sit on a stale copy across midnight in either
 * frame. **A new source that reads `now` more finely than a day must be accounted for here.**
 */
export function calendarModifiedAt(snapshotMs: number, now: number): number {
  return Math.max(snapshotMs, startOfUtcDay(now), startOfLocalDay(now));
}

/**
 * Build the full `text/calendar` document for the feed. Reads the just-swapped, read-only
 * driver through the app repositories only; pure w.r.t. inventory (never mutates).
 */
export async function buildCalendar(driver: IDatabaseDriver, options: CalendarFeedOptions): Promise<string> {
  const events = await buildCalendarEvents(driver, options);
  const calendar: VCalendar = { prodId: CALENDAR_PRODID, calName: CALENDAR_NAME, events };
  return formatCalendar(calendar);
}

/** Build just the event list (exposed for focused testing over a hydrated fixture). */
export async function buildCalendarEvents(
  driver: IDatabaseDriver,
  options: CalendarFeedOptions,
): Promise<VEvent[]> {
  const wanted = (type: CalendarSourceType): boolean =>
    options.types === undefined || options.types.length === 0 || options.types.includes(type);

  const dtstamp = icalDateTimeUtc(options.dtstamp);
  const events: VEvent[] = [];
  if (wanted('loans')) events.push(...(await loanEvents(driver, dtstamp)));
  if (wanted('bookings')) events.push(...(await bookingEvents(driver, dtstamp, options.now)));
  if (wanted('maintenance')) events.push(...(await maintenanceEvents(driver, dtstamp, options.now)));
  if (wanted('warranty')) events.push(...(await warrantyEvents(driver, dtstamp, options.now)));
  return events;
}

/**
 * Collect up to {@link MAX_EVENTS_PER_SOURCE} rows from a paginated repository read, paging at
 * the repository ceiling. Stops at the first non-full page (mirrors the CSV export's collector).
 */
async function collect<T>(read: (limit: number, offset: number) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; rows.length < MAX_EVENTS_PER_SOURCE; offset += MAX_PAGE_SIZE) {
    const page = await read(MAX_PAGE_SIZE, offset);
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }
  return rows.length > MAX_EVENTS_PER_SOURCE ? rows.slice(0, MAX_EVENTS_PER_SOURCE) : rows;
}

/** An all-day VEVENT spanning a single day (`DTEND` is the exclusive next day). */
function allDayEvent(fields: {
  uid: string;
  dtstamp: ICalDate;
  day: ICalDate;
  summary: string;
  description?: string;
  category: string;
}): VEvent {
  return {
    uid: fields.uid,
    dtstamp: fields.dtstamp,
    start: fields.day,
    end: addDays(fields.day, 1),
    summary: fields.summary,
    ...(fields.description !== undefined && fields.description.length > 0
      ? { description: fields.description }
      : {}),
    categories: ['Gubbins', fields.category],
  };
}

// --- loans: open checkouts with a due date ----------------------------------------

async function loanEvents(driver: IDatabaseDriver, dtstamp: ICalDate): Promise<VEvent[]> {
  const repo = new CheckoutRepository(driver);
  const rows = await collect((limit, offset) => repo.listOpen({ limit, offset }));
  return rows.filter((c) => c.dueDate !== null).map((c) => loanEvent(c, dtstamp));
}

function loanEvent(checkout: CheckoutWithNames, dtstamp: ICalDate): VEvent {
  // The borrower may be a contact, a project or a location (B4) — `borrowerName` is resolved
  // per target type by the repository, so this reads correctly for all three.
  const detail = `On loan to ${checkout.borrowerName}. Quantity ${checkout.quantity}.`;
  return allDayEvent({
    uid: `loan-${checkout.id}${UID_SUFFIX}`,
    dtstamp,
    // A loan due date is stored at local end-of-day (issue #318), so read its *local* calendar day
    // (issue #321) — reading UTC components would push it a day late west of UTC.
    day: icalLocalDate(checkout.dueDate as number),
    summary: `Loan due: ${checkout.itemName}`,
    description: checkout.note ? `${detail} ${checkout.note}` : detail,
    category: 'Loan',
  });
}

// --- bookings: active asset bookings not yet passed --------------------------------

async function bookingEvents(driver: IDatabaseDriver, dtstamp: ICalDate, now: number): Promise<VEvent[]> {
  const repo = new AssetBookingRepository(driver);
  const rows = await collect((limit, offset) => repo.listUpcoming(now, { limit, offset }));
  return rows.map((b) => bookingEvent(b, dtstamp));
}

function bookingEvent(booking: AssetBookingWithNames, dtstamp: ICalDate): VEvent {
  const who = booking.contactName ? `Reserved for ${booking.contactName}.` : 'Reserved.';
  return {
    uid: `booking-${booking.id}${UID_SUFFIX}`,
    dtstamp,
    // A booking is an inclusive day range; the all-day DTEND is the day *after* the last day.
    start: icalDate(booking.startDate),
    end: addDays(icalDate(booking.endDate), 1),
    summary: `Booking: ${booking.itemName}`,
    ...(booking.note ? { description: `${who} ${booking.note}` } : { description: who }),
    categories: ['Gubbins', 'Booking'],
  };
}

// --- maintenance: TIME schedules with a computed due date -------------------------

async function maintenanceEvents(driver: IDatabaseDriver, dtstamp: ICalDate, now: number): Promise<VEvent[]> {
  const repo = new MaintenanceRepository(driver);
  const rows = await collect((limit, offset) => repo.listUpcoming(now, { limit, offset }));
  const events: VEvent[] = [];
  for (const schedule of rows) {
    const event = maintenanceEvent(schedule, dtstamp, now);
    if (event !== null) events.push(event);
  }
  return events;
}

/** Map the schedule DTO to the pure status seam's input (single-sourcing the due-date maths). */
function toScheduleState(schedule: MaintenanceScheduleWithItem): MaintenanceScheduleState {
  return {
    basis: schedule.basis,
    intervalDays: schedule.intervalDays,
    intervalUsage: schedule.intervalUsage,
    usageSinceService: schedule.usageSinceService,
    accrueCheckoutHours: schedule.accrueCheckoutHours,
    autoUsage: schedule.autoUsageHours,
    lastPerformedAt: schedule.lastPerformedAt,
    createdAt: schedule.createdAt,
  };
}

function maintenanceEvent(
  schedule: MaintenanceScheduleWithItem,
  dtstamp: ICalDate,
  now: number,
): VEvent | null {
  // Only TIME schedules have a calendar due date; a USAGE schedule fires by accrued usage, so it
  // has no date to place on a calendar and is skipped.
  const status = maintenanceStatus(toScheduleState(schedule), now);
  if (schedule.basis !== 'TIME' || status.dueAt === null) return null;
  const scope = schedule.locationName ? ` (${schedule.locationName})` : '';
  return allDayEvent({
    uid: `maintenance-${schedule.id}${UID_SUFFIX}`,
    dtstamp,
    // `status.dueAt` carries the service's local wall-clock time (issue #321), so read its *local*
    // calendar day — reading UTC components would slip the due date a day for a service logged near
    // midnight in a non-UTC zone.
    day: icalLocalDate(status.dueAt),
    summary: `Maintenance due: ${schedule.name} — ${schedule.itemName}${scope}`,
    description: schedule.note ?? undefined,
    category: 'Maintenance',
  });
}

// --- warranty: items with a warranty-expiry date ----------------------------------

async function warrantyEvents(driver: IDatabaseDriver, dtstamp: ICalDate, now: number): Promise<VEvent[]> {
  const repo = new ItemRepository(driver);
  const rows = await collect((limit, offset) =>
    repo.listWarrantyExpiring(WARRANTY_HORIZON_DAYS, now, { limit, offset }),
  );
  const events: VEvent[] = [];
  for (const item of rows) {
    const event = warrantyEvent(item, dtstamp);
    if (event !== null) events.push(event);
  }
  return events;
}

function warrantyEvent(item: Item, dtstamp: ICalDate): VEvent | null {
  if (item.warrantyExpiresAt === null) return null;
  const day = icalDateFromIso(item.warrantyExpiresAt);
  if (day === null) return null; // a malformed stored date is skipped, not emitted broken
  return allDayEvent({
    uid: `warranty-${item.id}${UID_SUFFIX}`,
    dtstamp,
    day,
    summary: `Warranty expires: ${item.name}`,
    description: item.manufacturer ? `Manufacturer: ${item.manufacturer}.` : undefined,
    category: 'Warranty',
  });
}
