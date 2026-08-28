/**
 * Drift test: the alert centre and the Upcoming agenda must name the **same day** for the same
 * maintenance schedule (issue #497).
 *
 * Scope is that one lane, deliberately. The two seams also share three day-grained values —
 * expiry, warranty and custom-field due dates — but there they already disagree, and have since
 * #328: the alert centre reads them in UTC (`calendarDate`, which is what a midnight-UTC value
 * asks for) while `useAgenda` hands `buildAgenda` only `date`, so the agenda renders them in the
 * host zone and slips them a day west of UTC. That is the agenda's bug, not this one's, and
 * asserting parity over those lanes here would pin the wrong side of it.
 *
 * The two seams are separate by design — `buildAlerts` grades what is overdue, `buildAgenda`
 * lays out what is coming — but they read one value, `maintenanceDueAtMs`, and a user reads both.
 * The alert centre used to slice that instant's `toISOString()`, so an evening service west of
 * UTC was announced a day later in the alert than the agenda, the schedule's own editor and the
 * subscribed calendar feed all gave it. Nothing in either module's types could catch that: both
 * produced a plausible date string, and only the pair disagreed.
 *
 * The test therefore drives both builders over one schedule and compares the copy they emit,
 * rather than restating either lane's formatting rule. Put the alert lane back on UTC components
 * and this goes red.
 *
 * The clock-injected `date` formatter is pinned to `America/New_York`, standing in for a host
 * zone west of UTC. Pinning it (rather than trusting the test machine's zone) is what makes the
 * assertion mean something on a UTC CI runner, where a wall-clock instant and its UTC form name
 * the same day and the bug is invisible.
 */
import { describe, it, expect } from 'vitest';
import { buildAlerts, type AlertDateFormatters, type AlertSources } from './alerts';
import { buildAgenda, type AgendaSources } from '@/features/calendar/agenda';

/** A host zone west of UTC, so a late-evening local instant is already "tomorrow" in UTC. */
const HOST_ZONE = 'America/New_York';

const HOST_DATE = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: HOST_ZONE,
});
const UTC_DATE = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Shaped like the real `Formatters` bundle: `date` in the host zone, `calendarDate` in UTC. */
const FMT: AlertDateFormatters = {
  date: (ms) => HOST_DATE.format(new Date(ms)),
  calendarDate: (ms) => UTC_DATE.format(new Date(ms)),
};

/**
 * The service was logged at 21:00 on 24 Aug 2026 in New York, so a 30-day interval falls due at
 * the same wall-clock time — which is 01:00 on the **25th** in UTC. The day the user is owed is
 * the 24th.
 */
const DUE_AT_MS = Date.parse('2026-08-25T01:00:00.000Z');
const LOCAL_DAY = '24 Aug 2026';

/** A `now` a fortnight past the due date, so the schedule is unambiguously overdue in both seams. */
const NOW = DUE_AT_MS + 14 * 24 * 60 * 60 * 1000;

const EMPTY_ALERT_SOURCES: AlertSources = {
  lowStock: [],
  expiring: [],
  maintenanceDue: [],
  warrantyItems: [],
  fieldDue: [],
};

const EMPTY_AGENDA_SOURCES: AgendaSources = {
  maintenance: [],
  warranty: [],
  expiry: [],
  checkouts: [],
  reorder: [],
  bookings: [],
  fieldDue: [],
};

describe('alert centre / agenda date parity (issue #497)', () => {
  it('names the same calendar day for one maintenance schedule due late in the local evening', () => {
    const [alert] = buildAlerts(
      {
        ...EMPTY_ALERT_SOURCES,
        maintenanceDue: [
          { id: 's1', name: 'Oil change', itemId: 'i1', itemName: 'Lathe', dueAtMs: DUE_AT_MS },
        ],
      },
      NOW,
      FMT,
    );
    const [event] = buildAgenda(
      {
        ...EMPTY_AGENDA_SOURCES,
        maintenance: [
          {
            scheduleId: 's1',
            itemId: 'i1',
            itemName: 'Lathe',
            scheduleName: 'Oil change',
            dueAtMs: DUE_AT_MS,
            usageDue: false,
          },
        ],
      },
      NOW,
      FMT.date,
    );

    expect(alert.detail).toContain(LOCAL_DAY);
    expect(event.detail).toContain(LOCAL_DAY);
    // Belt and braces: neither may name the UTC day the raw instant falls in.
    expect(alert.detail).not.toContain('25 Aug 2026');
    expect(event.detail).not.toContain('25 Aug 2026');
  });
});
