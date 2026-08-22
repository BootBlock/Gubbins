import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { utcDayToLocalDay } from '@/lib/calendar-days';
import {
  AGENDA_BUCKET_ORDER,
  AGENDA_KINDS,
  buildAgenda,
  bucketAgenda,
  bucketForDueAt,
  filterByKind,
  startOfLocalDay,
  type AgendaEvent,
  type AgendaKind,
  type AgendaSources,
} from './agenda';

// A fixed reference instant during a day (noon UTC-ish — the exact wall clock is irrelevant
// because boundaries are derived from startOfLocalDay, which the tests reuse).
const NOW = startOfLocalDay(Date.parse('2026-06-30T12:00:00Z')) + 12 * 60 * 60 * 1000;
const SOD = startOfLocalDay(NOW);

// A deterministic date formatter for the pure seam under test. The production hook injects
// `useFormatters().date` (locale-aware); the suite only asserts on names / relative phrasing /
// ordering, never the date text, so a fixed ISO stamp keeps the expectations timezone-stable.
const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const EMPTY: AgendaSources = {
  maintenance: [],
  warranty: [],
  expiry: [],
  checkouts: [],
  reorder: [],
  bookings: [],
  fieldDue: [],
};

describe('startOfLocalDay', () => {
  it('returns local midnight, idempotent', () => {
    const sod = startOfLocalDay(NOW);
    expect(startOfLocalDay(sod)).toBe(sod);
    expect(new Date(sod).getHours()).toBe(0);
    expect(new Date(sod).getMinutes()).toBe(0);
    expect(sod).toBeLessThanOrEqual(NOW);
  });
});

describe('bucketForDueAt', () => {
  it('classifies instants before today as overdue', () => {
    expect(bucketForDueAt(SOD - 1, NOW)).toBe('overdue'); // one ms before today started
    expect(bucketForDueAt(SOD - MS_PER_DAY, NOW)).toBe('overdue');
  });

  it('classifies the whole of today as today, including earlier today', () => {
    expect(bucketForDueAt(SOD, NOW)).toBe('today'); // start of today
    expect(bucketForDueAt(NOW - 1, NOW)).toBe('today'); // earlier today, before `now`
    expect(bucketForDueAt(NOW, NOW)).toBe('today');
    expect(bucketForDueAt(SOD + MS_PER_DAY - 1, NOW)).toBe('today'); // last ms of today
  });

  it('keeps an event due earlier today in Today, not Overdue (issue #322)', () => {
    // Warranty/expiry dates are anchored at the START of their day, so an event due today is
    // already earlier than a midday `now`. Bucketing on `dueAt < now` swept every one of them into
    // Overdue; they must sit in Today. `SOD` (start of today) is the worst case and is strictly
    // before `NOW` in every zone, since `NOW` is deliberately noon-of-its-local-day.
    expect(SOD).toBeLessThan(NOW);
    expect(bucketForDueAt(SOD, NOW)).toBe('today');
  });

  it('classifies the next 7 days as week, then 30 days as month, then later', () => {
    expect(bucketForDueAt(SOD + MS_PER_DAY, NOW)).toBe('week'); // start of tomorrow
    expect(bucketForDueAt(SOD + 6 * MS_PER_DAY, NOW)).toBe('week');
    expect(bucketForDueAt(SOD + 7 * MS_PER_DAY, NOW)).toBe('month');
    expect(bucketForDueAt(SOD + 29 * MS_PER_DAY, NOW)).toBe('month');
    expect(bucketForDueAt(SOD + 30 * MS_PER_DAY, NOW)).toBe('later');
    expect(bucketForDueAt(SOD + 365 * MS_PER_DAY, NOW)).toBe('later');
  });
});

describe('buildAgenda — lane builders', () => {
  it('emits a TIME maintenance event with its calendar due date', () => {
    const due = SOD + 3 * MS_PER_DAY;
    const events = buildAgenda(
      {
        ...EMPTY,
        maintenance: [
          {
            scheduleId: 's1',
            itemId: 'i1',
            itemName: 'Lathe',
            scheduleName: 'Oil change',
            dueAtMs: due,
            usageDue: false,
          },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'maintenance:s1',
      kind: 'maintenance',
      dueAt: due,
      hasDate: true,
      target: { route: '/inventory', itemId: 'i1' },
    });
  });

  it('surfaces a USAGE maintenance schedule only when due (anchored at now, no date)', () => {
    const base = {
      scheduleId: 's',
      itemId: 'i',
      itemName: 'Drill',
      scheduleName: 'Service',
      dueAtMs: null,
    };
    const due = buildAgenda({ ...EMPTY, maintenance: [{ ...base, usageDue: true }] }, NOW, fmtDate);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ dueAt: NOW, hasDate: false });

    const notDue = buildAgenda({ ...EMPTY, maintenance: [{ ...base, usageDue: false }] }, NOW, fmtDate);
    expect(notDue).toHaveLength(0);
  });

  it('emits warranty events, skipping null and unparseable dates', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        warranty: [
          { id: 'a', name: 'Printer', warrantyExpiresAt: '2026-12-01' },
          { id: 'b', name: 'No warranty', warrantyExpiresAt: null },
          { id: 'c', name: 'Bad date', warrantyExpiresAt: 'not-a-date' },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['warranty:a:2026-12-01']);
    expect(events[0].dueAt).toBe(Date.parse('2026-12-01'));
  });

  it('emits expiry events, skipping items without an expiry date', () => {
    const exp = SOD + 2 * MS_PER_DAY;
    const events = buildAgenda(
      {
        ...EMPTY,
        expiry: [
          { id: 'x', name: 'Milk', effectiveExpiryDate: exp },
          { id: 'y', name: 'Bolt', effectiveExpiryDate: null },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['expiry:x']);
    expect(events[0].dueAt).toBe(exp);
  });

  it('emits checkout-due events only for loans with a due date', () => {
    const due = SOD + 5 * MS_PER_DAY;
    const events = buildAgenda(
      {
        ...EMPTY,
        checkouts: [
          { id: 'k1', itemId: 'i1', itemName: 'Camera', borrowerName: 'Sam', dueDate: due },
          { id: 'k2', itemId: 'i2', itemName: 'Tripod', borrowerName: 'Lee', dueDate: null },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['checkout-due:k1']);
    expect(events[0].detail).toContain('Sam');
    // A not-yet-due loan reads plainly, with no overdue affordance.
    expect(events[0].detail).not.toContain('overdue');
  });

  it('spells out how overdue a late loan is in its detail (mirroring low stock)', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        checkouts: [
          { id: 'k1', itemId: 'i1', itemName: 'Camera', borrowerName: 'Sam', dueDate: SOD - 3 * MS_PER_DAY },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('checkout-due');
    expect(events[0].detail).toContain('3 days overdue');
    // Overdue events keep their real (past) due date so they sort to the top and bucket overdue.
    expect(events[0].dueAt).toBe(SOD - 3 * MS_PER_DAY);
    expect(bucketForDueAt(events[0].dueAt, NOW)).toBe('overdue');
  });

  it('reads a loan due today plainly in Today, never tagged Overdue (issue #322)', () => {
    // `SOD` is the start of today and strictly before the midday `NOW`, so the old `dueDate < now`
    // affordance would have tagged it "Overdue" — yet it buckets into Today. The affordance now
    // keys off the same calendar-day boundary, so the heading and the copy agree.
    const events = buildAgenda(
      {
        ...EMPTY,
        checkouts: [{ id: 'k1', itemId: 'i1', itemName: 'Camera', borrowerName: 'Sam', dueDate: SOD }],
      },
      NOW,
      fmtDate,
    );
    expect(events).toHaveLength(1);
    expect(events[0].detail).not.toContain('overdue');
    expect(events[0].detail).not.toContain('Overdue');
    expect(bucketForDueAt(events[0].dueAt, NOW)).toBe('today');
  });

  it('sorts an overdue loan ahead of a soon-due one (overdue before upcoming)', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        checkouts: [
          { id: 'soon', itemId: 'i1', itemName: 'Drill', borrowerName: 'Lee', dueDate: SOD + 2 * MS_PER_DAY },
          { id: 'late', itemId: 'i2', itemName: 'Saw', borrowerName: 'Ada', dueDate: SOD - MS_PER_DAY },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['checkout-due:late', 'checkout-due:soon']);
  });

  it('emits reorder events anchored at now (date-less), pluralising the shortfall', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        reorder: [
          { itemId: 'i1', itemName: 'Screws', shortfall: 1 },
          { itemId: 'i2', itemName: 'Nuts', shortfall: 5 },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.dueAt).toBe(NOW);
      expect(e.hasDate).toBe(false);
      expect(e.target.route).toBe('/purchase-orders');
    }
    expect(events.find((e) => e.id === 'reorder:i1')!.detail).toContain('1 unit ');
    expect(events.find((e) => e.id === 'reorder:i2')!.detail).toContain('5 units');
  });

  it('emits an upcoming booking anchored at its start date', () => {
    const start = SOD + 5 * MS_PER_DAY;
    const end = SOD + 7 * MS_PER_DAY;
    const events = buildAgenda(
      {
        ...EMPTY,
        bookings: [
          { id: 'b1', itemId: 'i1', itemName: 'Laser', contactName: 'Ada', startDate: start, endDate: end },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.id).toBe('booking:b1');
    expect(event.kind).toBe('booking');
    expect(event.dueAt).toBe(start);
    expect(event.hasDate).toBe(true);
    expect(event.detail).toContain('Ada');
    expect(event.target.route).toBe('/bookings');
  });

  it('anchors a booking already under way at now (so it reads as Today)', () => {
    // Window started yesterday and ends in three days — currently active.
    const events = buildAgenda(
      {
        ...EMPTY,
        bookings: [
          {
            id: 'b2',
            itemId: 'i2',
            itemName: 'Plotter',
            contactName: null,
            startDate: SOD - MS_PER_DAY,
            endDate: SOD + 3 * MS_PER_DAY,
          },
        ],
      },
      NOW,
      fmtDate,
    );
    expect(events[0]!.dueAt).toBe(NOW);
    expect(events[0]!.hasDate).toBe(false);
    expect(bucketForDueAt(events[0]!.dueAt, NOW)).toBe('today');
  });

  it('sorts every lane soonest-first with a deterministic id tie-break', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        expiry: [
          { id: 'late', name: 'Late', effectiveExpiryDate: SOD + 10 * MS_PER_DAY },
          { id: 'soon', name: 'Soon', effectiveExpiryDate: SOD + 1 * MS_PER_DAY },
        ],
        reorder: [{ itemId: 'r', itemName: 'R', shortfall: 2 }], // dueAt = NOW (earliest)
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['reorder:r', 'expiry:soon', 'expiry:late']);
  });
});

describe('bucketAgenda', () => {
  it('groups into ordered, non-empty sections', () => {
    const events: AgendaEvent[] = buildAgenda(
      {
        ...EMPTY,
        expiry: [
          { id: 'overdue', name: 'O', effectiveExpiryDate: NOW - MS_PER_DAY },
          { id: 'week', name: 'W', effectiveExpiryDate: SOD + 3 * MS_PER_DAY },
          { id: 'later', name: 'L', effectiveExpiryDate: SOD + 90 * MS_PER_DAY },
        ],
        reorder: [{ itemId: 'today', itemName: 'T', shortfall: 1 }], // today
      },
      NOW,
      fmtDate,
    );
    const sections = bucketAgenda(events, NOW);
    expect(sections.map((s) => s.bucket)).toEqual(['overdue', 'today', 'week', 'later']);
    expect(sections.every((s) => s.events.length > 0)).toBe(true);
    expect(sections[0].label).toBe('Overdue');
  });

  it('returns no sections for an empty agenda', () => {
    expect(bucketAgenda([], NOW)).toEqual([]);
  });

  it('respects the canonical bucket order', () => {
    expect(AGENDA_BUCKET_ORDER).toEqual(['overdue', 'today', 'week', 'month', 'later']);
  });
});

describe('filterByKind', () => {
  const events = buildAgenda(
    {
      ...EMPTY,
      expiry: [{ id: 'x', name: 'X', effectiveExpiryDate: SOD + MS_PER_DAY }],
      reorder: [{ itemId: 'r', itemName: 'R', shortfall: 1 }],
    },
    NOW,
    fmtDate,
  );

  it('keeps only the enabled kinds', () => {
    const onlyExpiry = filterByKind(events, new Set<AgendaKind>(['expiry']));
    expect(onlyExpiry.map((e) => e.kind)).toEqual(['expiry']);
  });

  it('yields nothing for an empty enabled set', () => {
    expect(filterByKind(events, new Set())).toEqual([]);
  });

  it('exposes all seven kinds', () => {
    expect([...AGENDA_KINDS].sort()).toEqual(
      ['booking', 'checkout-due', 'expiry', 'field-due', 'maintenance', 'reorder', 'warranty'].sort(),
    );
  });
});

describe('buildAgenda — custom-field due-date lane (W1a)', () => {
  /**
   * The **stored** instant for a calendar day `offset` days from today: midnight UTC, which is
   * the convention every day-grained value uses (issue #320) — not local midnight. The
   * distinction is the point of this lane's re-anchoring, so the fixture has to honour it.
   */
  const storedDay = (offset: number): number => {
    const today = new Date(SOD);
    return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  };

  const source = {
    itemId: 'i1',
    itemName: 'Studio insurance',
    defId: 'd1',
    fieldName: 'Renewal date',
    dueAt: storedDay(3),
  };

  it('names the field in the title, so several dated fields stay distinguishable', () => {
    const [event] = buildAgenda({ ...EMPTY, fieldDue: [source] }, NOW, fmtDate);
    expect(event.title).toBe('Renewal date — Studio insurance');
    expect(event.kind).toBe('field-due');
  });

  it('carries a real date, unlike the reorder and due-USAGE lanes', () => {
    const [event] = buildAgenda({ ...EMPTY, fieldDue: [source] }, NOW, fmtDate);
    expect(event.dueAt).toBe(utcDayToLocalDay(source.dueAt));
    expect(event.hasDate).toBe(true);
  });

  it('keys the id on item AND definition, so two dated fields on one item both appear', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        fieldDue: [source, { ...source, defId: 'd2', fieldName: 'Inspection due' }],
      },
      NOW,
      fmtDate,
    );
    expect(events.map((e) => e.id)).toEqual(['field-due:i1:d1', 'field-due:i1:d2']);
  });

  it('shows a far-future date rather than hiding it — the agenda is the forward calendar', () => {
    const far = { ...source, dueAt: storedDay(900) };
    const [event] = buildAgenda({ ...EMPTY, fieldDue: [far] }, NOW, fmtDate);
    expect(bucketForDueAt(event.dueAt, NOW)).toBe('later');
  });

  it('deep-links to the item it belongs to', () => {
    const [event] = buildAgenda({ ...EMPTY, fieldDue: [source] }, NOW, fmtDate);
    expect(event.target).toEqual({ route: '/inventory', itemId: 'i1' });
  });

  it('re-anchors the stored day onto the local calendar, at the day start', () => {
    // The value is stored at midnight UTC (issue #320) but everything downstream reads the
    // event's `dueAt` locally — the bucketer against `startOfLocalDay`, the card through the
    // locale formatter. West of UTC the raw instant is the *previous* local day, so a date due
    // today would bucket Overdue and render a day early (issue #323), while the alert centre
    // graded the same row due-soon.
    //
    // The fixture is deliberately **off** a UTC midnight, and that is the whole point of it:
    // `utcDayToLocalDay` is the identity function in UTC, so a midnight-UTC fixture is
    // indistinguishable from the un-anchored result exactly where this suite runs in CI — the
    // guard would pass with the transform deleted. An off-midnight instant makes the assertion
    // bite in every zone, since only the anchoring collapses it to the day start.
    const offMidnight = storedDay(0) + 13 * 60 * 60 * 1000;
    const [event] = buildAgenda({ ...EMPTY, fieldDue: [{ ...source, dueAt: offMidnight }] }, NOW, fmtDate);
    expect(event.dueAt).toBe(SOD);
    expect(bucketForDueAt(event.dueAt, NOW)).toBe('today');
  });
});
