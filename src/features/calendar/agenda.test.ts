import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories/constants';
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

const EMPTY: AgendaSources = {
  maintenance: [],
  warranty: [],
  expiry: [],
  checkouts: [],
  reorder: [],
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
  it('classifies past instants as overdue', () => {
    expect(bucketForDueAt(NOW - 1, NOW)).toBe('overdue');
    expect(bucketForDueAt(SOD - MS_PER_DAY, NOW)).toBe('overdue');
  });

  it('classifies the rest of today as today', () => {
    expect(bucketForDueAt(NOW, NOW)).toBe('today'); // exactly now is not "past"
    expect(bucketForDueAt(SOD + MS_PER_DAY - 1, NOW)).toBe('today');
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
    const due = buildAgenda({ ...EMPTY, maintenance: [{ ...base, usageDue: true }] }, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ dueAt: NOW, hasDate: false });

    const notDue = buildAgenda({ ...EMPTY, maintenance: [{ ...base, usageDue: false }] }, NOW);
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
          { id: 'x', name: 'Milk', expiryDate: exp },
          { id: 'y', name: 'Bolt', expiryDate: null },
        ],
      },
      NOW,
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
          { id: 'k1', itemId: 'i1', itemName: 'Camera', contactName: 'Sam', dueDate: due },
          { id: 'k2', itemId: 'i2', itemName: 'Tripod', contactName: 'Lee', dueDate: null },
        ],
      },
      NOW,
    );
    expect(events.map((e) => e.id)).toEqual(['checkout-due:k1']);
    expect(events[0].detail).toContain('Sam');
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

  it('sorts every lane soonest-first with a deterministic id tie-break', () => {
    const events = buildAgenda(
      {
        ...EMPTY,
        expiry: [
          { id: 'late', name: 'Late', expiryDate: SOD + 10 * MS_PER_DAY },
          { id: 'soon', name: 'Soon', expiryDate: SOD + 1 * MS_PER_DAY },
        ],
        reorder: [{ itemId: 'r', itemName: 'R', shortfall: 2 }], // dueAt = NOW (earliest)
      },
      NOW,
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
          { id: 'overdue', name: 'O', expiryDate: NOW - MS_PER_DAY },
          { id: 'week', name: 'W', expiryDate: SOD + 3 * MS_PER_DAY },
          { id: 'later', name: 'L', expiryDate: SOD + 90 * MS_PER_DAY },
        ],
        reorder: [{ itemId: 'today', itemName: 'T', shortfall: 1 }], // today
      },
      NOW,
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
      expiry: [{ id: 'x', name: 'X', expiryDate: SOD + MS_PER_DAY }],
      reorder: [{ itemId: 'r', itemName: 'R', shortfall: 1 }],
    },
    NOW,
  );

  it('keeps only the enabled kinds', () => {
    const onlyExpiry = filterByKind(events, new Set<AgendaKind>(['expiry']));
    expect(onlyExpiry.map((e) => e.kind)).toEqual(['expiry']);
  });

  it('yields nothing for an empty enabled set', () => {
    expect(filterByKind(events, new Set())).toEqual([]);
  });

  it('exposes all five kinds', () => {
    expect([...AGENDA_KINDS].sort()).toEqual(
      ['checkout-due', 'expiry', 'maintenance', 'reorder', 'warranty'].sort(),
    );
  });
});
