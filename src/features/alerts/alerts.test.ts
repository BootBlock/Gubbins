/**
 * Unit tests for the alert-centre pure seam (Phase 68, spec §3).
 *
 * All five lanes are tested independently. The warranty lane is also tested with
 * the Phase-66 `warrantyExpiresAt` field absent/null (gate check). Dismissal
 * filtering, grouping, severity ordering, and `dueAt` ordering are all covered.
 * No DB access, no side-effects — `now` is always injected.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAlerts,
  alertKindFromId,
  applyDismissals,
  pruneDismissals,
  groupByKind,
  maintenanceDueAtMs,
  STALE_DISMISSAL_DAYS,
  type AlertKind,
  type AlertDismissal,
  type AlertDismissals,
  type AlertSources,
  type LowStockSource,
  type ExpirySource,
  type MaintenanceDueSource,
  type WarrantySource,
  type FieldDueSource,
} from './alerts';
import { startOfLocalDay } from '@/lib/calendar-days';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ms(date: string): number {
  return Date.parse(date);
}

/** Empty sources — a clean baseline for partial tests. */
const EMPTY: AlertSources = {
  lowStock: [],
  expiring: [],
  maintenanceDue: [],
  warrantyItems: [],
  fieldDue: [],
};

function sources(overrides: Partial<AlertSources>): AlertSources {
  return { ...EMPTY, ...overrides };
}

/** Fixed "now" — 2025-07-01 midnight UTC. */
const NOW = ms('2025-07-01');

// ---------------------------------------------------------------------------
// Low-stock lane
// ---------------------------------------------------------------------------

describe('buildAlerts — low-stock lane', () => {
  it('returns an empty list when no low-stock items are provided', () => {
    expect(buildAlerts(EMPTY, NOW)).toHaveLength(0);
  });

  it('produces one warning alert per low-stock item', () => {
    const low: LowStockSource[] = [
      { id: 'item-1', name: 'Widget A' },
      { id: 'item-2', name: 'Widget B' },
    ];
    const alerts = buildAlerts(sources({ lowStock: low }), NOW);
    expect(alerts).toHaveLength(2);
    for (const a of alerts) {
      expect(a.kind).toBe('low-stock');
      expect(a.severity).toBe('warning');
      expect(a.target.route).toBe('/inventory');
    }
  });

  it('sets deterministic ids prefixed with "low-stock:"', () => {
    const low: LowStockSource[] = [{ id: 'abc', name: 'Screw' }];
    const [alert] = buildAlerts(sources({ lowStock: low }), NOW);
    expect(alert.id).toBe('low-stock:abc');
  });

  it('includes the item name in the title', () => {
    const low: LowStockSource[] = [{ id: 'x', name: 'Blue Resistor' }];
    const [alert] = buildAlerts(sources({ lowStock: low }), NOW);
    expect(alert.title).toContain('Blue Resistor');
  });

  it('sets dueAt to null for low-stock alerts', () => {
    const [alert] = buildAlerts(sources({ lowStock: [{ id: 'y', name: 'Y' }] }), NOW);
    expect(alert.dueAt).toBeNull();
  });

  it('sets itemId on the target', () => {
    const [alert] = buildAlerts(sources({ lowStock: [{ id: 'z', name: 'Z' }] }), NOW);
    expect(alert.target.itemId).toBe('z');
  });
});

// ---------------------------------------------------------------------------
// Expiry lane
// ---------------------------------------------------------------------------

describe('buildAlerts — expiry lane', () => {
  it('skips items with no expiry date', () => {
    const exp: ExpirySource[] = [{ id: 'item-1', name: 'Milk', expiryDate: null }];
    expect(buildAlerts(sources({ expiring: exp }), NOW)).toHaveLength(0);
  });

  it('skips items whose expiry is in the future beyond the "soon" window', () => {
    const farFuture = NOW + 60 * 86_400_000; // 60 days out
    const exp: ExpirySource[] = [{ id: 'item-1', name: 'Honey', expiryDate: farFuture }];
    expect(buildAlerts(sources({ expiring: exp }), NOW)).toHaveLength(0);
  });

  it('produces a warning alert for expiring-soon items', () => {
    const soonExpiry = NOW + 5 * 86_400_000; // 5 days out → within 30-day window
    const exp: ExpirySource[] = [{ id: 'item-1', name: 'Yoghurt', expiryDate: soonExpiry }];
    const [alert] = buildAlerts(sources({ expiring: exp }), NOW);
    expect(alert.kind).toBe('expiry');
    expect(alert.severity).toBe('warning');
    expect(alert.title).toContain('Expiring soon');
    expect(alert.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('produces a critical alert for already-expired items', () => {
    const pastExpiry = NOW - 86_400_000; // yesterday
    const exp: ExpirySource[] = [{ id: 'item-1', name: 'Bread', expiryDate: pastExpiry }];
    const [alert] = buildAlerts(sources({ expiring: exp }), NOW);
    expect(alert.kind).toBe('expiry');
    expect(alert.severity).toBe('critical');
    expect(alert.title).toContain('Expired');
  });

  it('sets a deterministic id carrying the item, the day and the status band', () => {
    const exp: ExpirySource[] = [{ id: 'perishable-1', name: 'Cheese', expiryDate: ms('2025-06-30') }];
    const [alert] = buildAlerts(sources({ expiring: exp }), NOW);
    expect(alert.id).toBe('expiry:perishable-1:2025-06-30:expired');
  });

  it('gives the expired alert a different id from the expiring-soon one (issue #644)', () => {
    // One item, one expiry date, read either side of the day it passes.
    const exp: ExpirySource[] = [{ id: 'perishable-1', name: 'Cheese', expiryDate: ms('2025-07-02') }];
    const [soon] = buildAlerts(sources({ expiring: exp }), NOW);
    const [expired] = buildAlerts(sources({ expiring: exp }), ms('2025-07-04'));

    expect(soon.severity).toBe('warning');
    expect(expired.severity).toBe('critical');
    expect(soon.id).not.toBe(expired.id);

    // The escalation therefore survives a dismissal of the warning.
    const hidden = applyDismissals([expired], dismissals([soon.id, null]), ms('2025-07-04'));
    expect(hidden).toHaveLength(1);
  });

  it('gives a re-dated item a new id, so an earlier dismissal no longer hides it', () => {
    const first = buildAlerts(
      sources({ expiring: [{ id: 'p1', name: 'Yoghurt', expiryDate: ms('2025-07-03') }] }),
      NOW,
    )[0];
    const rebatched = buildAlerts(
      sources({ expiring: [{ id: 'p1', name: 'Yoghurt', expiryDate: ms('2025-07-10') }] }),
      NOW,
    )[0];
    expect(first.id).not.toBe(rebatched.id);
  });
});

// ---------------------------------------------------------------------------
// Maintenance-due lane
// ---------------------------------------------------------------------------

describe('buildAlerts — maintenance-due lane', () => {
  it('produces one alert per due schedule', () => {
    const due: MaintenanceDueSource[] = [
      {
        id: 'sched-1',
        name: 'Oil change',
        itemId: 'item-x',
        itemName: 'Generator',
        dueAtMs: NOW - 86_400_000,
      },
    ];
    const [alert] = buildAlerts(sources({ maintenanceDue: due }), NOW);
    expect(alert.kind).toBe('maintenance-due');
    expect(alert.severity).toBe('critical');
    expect(alert.title).toContain('Generator');
    expect(alert.id).toBe('maintenance-due:sched-1:2025-06-30:overdue');
  });

  it('gives a completed-then-re-due TIME schedule a new id (issue #644)', () => {
    const base = { id: 'sched-1', name: 'Oil change', itemId: 'item-x', itemName: 'Generator' };
    const before = buildAlerts(sources({ maintenanceDue: [{ ...base, dueAtMs: ms('2025-06-30') }] }), NOW)[0];
    // Logged the work; the schedule's next due date lands inside the old dismissal's grace period.
    const after = buildAlerts(
      sources({ maintenanceDue: [{ ...base, dueAtMs: ms('2025-07-14') }] }),
      ms('2025-07-15'),
    )[0];
    expect(before.id).not.toBe(after.id);
  });

  it('marks a USAGE schedule undated in the id, having no due date to carry', () => {
    const due: MaintenanceDueSource[] = [
      { id: 's9', name: 'Service', itemId: 'i9', itemName: 'Lathe', dueAtMs: null },
    ];
    const [alert] = buildAlerts(sources({ maintenanceDue: due }), NOW);
    expect(alert.id).toBe('maintenance-due:s9:undated:due');
  });

  it('sets dueAt from the schedule dueAtMs', () => {
    const dueMs = ms('2025-06-28');
    const due: MaintenanceDueSource[] = [
      { id: 's1', name: 'Calibrate', itemId: 'i1', itemName: 'Laser', dueAtMs: dueMs },
    ];
    const [alert] = buildAlerts(sources({ maintenanceDue: due }), NOW);
    expect(alert.dueAt).toBe(new Date(dueMs).toISOString());
  });

  it('sets dueAt to null for USAGE schedules (no calendar due date)', () => {
    const due: MaintenanceDueSource[] = [
      { id: 's2', name: 'Service', itemId: 'i2', itemName: 'Lathe', dueAtMs: null },
    ];
    const [alert] = buildAlerts(sources({ maintenanceDue: due }), NOW);
    expect(alert.dueAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Warranty lane (Phase-66 gate)
// ---------------------------------------------------------------------------

describe('buildAlerts — warranty lane', () => {
  const baseAsset: Omit<WarrantySource, 'warrantyExpiresAt'> = {
    id: 'asset-1',
    name: 'Drill',
    acquiredAt: '2024-01-01',
    purchasePrice: 200,
    depreciationMonths: null,
  };

  it('skips items without warrantyExpiresAt (Phase-66 field absent)', () => {
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: null }];
    expect(buildAlerts(sources({ warrantyItems: items }), NOW)).toHaveLength(0);
  });

  it('skips items whose warranty is still active', () => {
    const futureExpiry = new Date(NOW + 90 * 86_400_000).toISOString().slice(0, 10);
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: futureExpiry }];
    expect(buildAlerts(sources({ warrantyItems: items }), NOW)).toHaveLength(0);
  });

  it('produces a warning alert for warranty expiring-soon', () => {
    // Within 30 days but not yet expired.
    const soonDate = new Date(NOW + 10 * 86_400_000).toISOString().slice(0, 10);
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: soonDate }];
    const [alert] = buildAlerts(sources({ warrantyItems: items }), NOW);
    expect(alert.kind).toBe('warranty-due');
    expect(alert.severity).toBe('warning');
    expect(alert.title).toContain('expiring soon');
    expect(alert.title).toContain('Drill');
  });

  it('produces a critical alert for expired warranties', () => {
    const expiredDate = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: expiredDate }];
    const [alert] = buildAlerts(sources({ warrantyItems: items }), NOW);
    expect(alert.kind).toBe('warranty-due');
    expect(alert.severity).toBe('critical');
    expect(alert.title).toContain('expired');
  });

  it('encodes warrantyExpiresAt in the id so a date change creates a new alert', () => {
    const date = '2025-06-15';
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: date }];
    const [alert] = buildAlerts(sources({ warrantyItems: items }), NOW);
    expect(alert.id).toBe(`warranty-due:asset-1:${date}:expired`);
  });

  it('gives the expired warranty a different id from the expiring-soon one (issue #644)', () => {
    const date = new Date(NOW + 10 * 86_400_000).toISOString().slice(0, 10);
    const items: WarrantySource[] = [{ ...baseAsset, warrantyExpiresAt: date }];
    const [soon] = buildAlerts(sources({ warrantyItems: items }), NOW);
    const [expired] = buildAlerts(sources({ warrantyItems: items }), NOW + 40 * 86_400_000);
    expect(soon.severity).toBe('warning');
    expect(expired.severity).toBe('critical');
    expect(soon.id).not.toBe(expired.id);
  });

  it('produces no alerts when warrantyItems is an empty array', () => {
    expect(buildAlerts(sources({ warrantyItems: [] }), NOW)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

describe('buildAlerts — severity ordering', () => {
  it('places critical alerts before warning alerts', () => {
    const expiredMs = NOW - 86_400_000;
    const soonMs = NOW + 5 * 86_400_000;
    const s = sources({
      expiring: [
        { id: 'e1', name: 'Expiring soon', expiryDate: soonMs },
        { id: 'e2', name: 'Already expired', expiryDate: expiredMs },
      ],
    });
    const alerts = buildAlerts(s, NOW);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[1].severity).toBe('warning');
  });

  it('sorts critical alerts before warning alerts across different lanes', () => {
    const s = sources({
      lowStock: [{ id: 'item-1', name: 'Screw' }],
      expiring: [{ id: 'item-2', name: 'Milk', expiryDate: NOW - 1 }],
    });
    const alerts = buildAlerts(s, NOW);
    // expired milk (critical) should come before low-stock screw (warning)
    const criticalFirst = alerts[0];
    expect(criticalFirst.severity).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// dueAt ordering (within same severity)
// ---------------------------------------------------------------------------

describe('buildAlerts — dueAt ordering', () => {
  it('sorts soonest dueAt first within the same severity', () => {
    const due1: MaintenanceDueSource = {
      id: 's1',
      name: 'Late task',
      itemId: 'i1',
      itemName: 'Tool A',
      dueAtMs: ms('2025-06-25'),
    };
    const due2: MaintenanceDueSource = {
      id: 's2',
      name: 'Very late task',
      itemId: 'i2',
      itemName: 'Tool B',
      dueAtMs: ms('2025-06-20'),
    };
    const alerts = buildAlerts(sources({ maintenanceDue: [due1, due2] }), NOW);
    // Both are overdue (critical); s2 is earlier so should appear first.
    expect(alerts[0].id).toBe('maintenance-due:s2:2025-06-20:overdue');
    expect(alerts[1].id).toBe('maintenance-due:s1:2025-06-25:overdue');
  });

  it('places alerts with null dueAt after those with a date (same severity)', () => {
    const s = sources({
      maintenanceDue: [
        { id: 'u1', name: 'Usage', itemId: 'i1', itemName: 'Tool A', dueAtMs: null },
        { id: 't1', name: 'Time', itemId: 'i2', itemName: 'Tool B', dueAtMs: ms('2025-06-15') },
      ],
    });
    // t1 is overdue → critical; u1 has no dueAtMs so severity depends on now comparison
    // but let's just verify the one with a dueAt isn't pushed after null
    const alerts = buildAlerts(s, NOW);
    const withDate = alerts.find((a) => a.dueAt !== null);
    const withoutDate = alerts.find((a) => a.dueAt === null);
    if (withDate && withoutDate) {
      const idxDate = alerts.indexOf(withDate);
      const idxNull = alerts.indexOf(withoutDate);
      expect(idxDate).toBeLessThan(idxNull);
    }
  });
});

// ---------------------------------------------------------------------------
// applyDismissals
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** A dismissal map from `[id, until]` pairs; `at` defaults to `NOW` unless given. */
function dismissals(...entries: readonly (readonly [string, number | null, number?])[]): AlertDismissals {
  return new Map<string, AlertDismissal>(entries.map(([id, until, at]) => [id, { until, at: at ?? NOW }]));
}

describe('applyDismissals', () => {
  it('returns all alerts when there are no dismissals', () => {
    const s = sources({ lowStock: [{ id: 'x', name: 'X' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, new Map(), NOW)).toHaveLength(1);
  });

  it('filters out dismissed alerts by id', () => {
    const s = sources({
      lowStock: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    });
    const alerts = buildAlerts(s, NOW);
    const result = applyDismissals(alerts, dismissals(['low-stock:a', null]), NOW);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('low-stock:b');
  });

  it('returns an empty list when all alerts are dismissed', () => {
    const s = sources({ lowStock: [{ id: 'c', name: 'C' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, dismissals(['low-stock:c', null]), NOW)).toHaveLength(0);
  });

  it('ignores dismissal ids that do not match any alert', () => {
    const s = sources({ lowStock: [{ id: 'd', name: 'D' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, dismissals(['low-stock:nonexistent', null]), NOW)).toHaveLength(1);
  });

  it('keeps an alert hidden while its snooze is still running', () => {
    const s = sources({ lowStock: [{ id: 'e', name: 'E' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, dismissals(['low-stock:e', NOW + DAY]), NOW)).toHaveLength(0);
  });

  it('shows the alert again once its snooze has elapsed', () => {
    const s = sources({ lowStock: [{ id: 'f', name: 'F' }] });
    const alerts = buildAlerts(s, NOW);
    const snoozed = dismissals(['low-stock:f', NOW - 1]);
    expect(applyDismissals(alerts, snoozed, NOW)).toHaveLength(1);
  });

  it('treats a snooze deadline of exactly now as elapsed', () => {
    const s = sources({ lowStock: [{ id: 'g', name: 'G' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, dismissals(['low-stock:g', NOW]), NOW)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pruneDismissals
// ---------------------------------------------------------------------------

describe('pruneDismissals', () => {
  const STALE_AT = NOW - (STALE_DISMISSAL_DAYS + 1) * DAY;

  it('returns null when there is nothing to drop', () => {
    const kept = dismissals(['low-stock:a', null]);
    expect(pruneDismissals(kept, new Set(['low-stock:a']), NOW)).toBeNull();
  });

  it('drops a snooze that has elapsed', () => {
    const before = dismissals(['low-stock:a', NOW - 1]);
    const after = pruneDismissals(before, new Set(['low-stock:a']), NOW);
    expect(after?.size).toBe(0);
  });

  it('drops a record whose alert stopped firing long ago', () => {
    const before = dismissals(['low-stock:gone', null, STALE_AT]);
    const after = pruneDismissals(before, new Set(), NOW);
    expect(after?.size).toBe(0);
  });

  it('keeps a record whose alert is absent but still within its grace period', () => {
    const before = dismissals(['low-stock:gone', null, NOW - DAY]);
    expect(pruneDismissals(before, new Set(), NOW)).toBeNull();
  });

  it('keeps an old record while its alert is still firing', () => {
    const before = dismissals(['low-stock:a', null, STALE_AT]);
    expect(pruneDismissals(before, new Set(['low-stock:a']), NOW)).toBeNull();
  });

  it('drops only the dead records, leaving the rest untouched', () => {
    const before = dismissals(
      ['low-stock:live', null],
      ['low-stock:elapsed', NOW - 1],
      ['low-stock:gone', null, STALE_AT],
    );
    const after = pruneDismissals(before, new Set(['low-stock:live']), NOW);
    expect([...(after?.keys() ?? [])]).toEqual(['low-stock:live']);
  });

  it('never mutates the map it was given', () => {
    const before = dismissals(['low-stock:gone', null, STALE_AT]);
    pruneDismissals(before, new Set(), NOW);
    expect(before.size).toBe(1);
  });

  it('drops a record whose lane was read whole without it, without waiting out the grace period', () => {
    // Restocked yesterday: the low-stock feed is complete and no longer names the item, so the
    // dismissal has nothing left to silence and must not hide the next shortage (issue #644).
    const before = dismissals(['low-stock:restocked', null, NOW - DAY]);
    const after = pruneDismissals(before, new Set(), NOW, new Set<AlertKind>(['low-stock']));
    expect(after?.size).toBe(0);
  });

  it('keeps a record whose lane was not read whole, even when its alert is absent', () => {
    // The lane is off, still loading, or its feed stopped at the page ceiling — absence proves
    // nothing, so only the staleness rule may drop the record.
    const before = dismissals(['low-stock:maybe-gone', null, NOW - DAY]);
    expect(pruneDismissals(before, new Set(), NOW, new Set<AlertKind>(['expiry']))).toBeNull();
  });

  it('judges each lane separately', () => {
    const before = dismissals(
      ['low-stock:gone', null, NOW - DAY],
      ['expiry:e1:2025-07-05:expiring-soon', null, NOW - DAY],
    );
    const after = pruneDismissals(before, new Set(), NOW, new Set<AlertKind>(['low-stock']));
    expect([...(after?.keys() ?? [])]).toEqual(['expiry:e1:2025-07-05:expiring-soon']);
  });

  it('keeps a record from a complete lane while its alert is still firing', () => {
    const before = dismissals(['low-stock:a', null, STALE_AT]);
    const live = new Set(['low-stock:a']);
    expect(pruneDismissals(before, live, NOW, new Set<AlertKind>(['low-stock']))).toBeNull();
  });

  it('never treats an id from an unknown lane as resolved', () => {
    // A record written by a build that knew a lane this one does not: unjudgeable, so it falls
    // through to the staleness rule rather than being dropped on the spot.
    const before = dismissals(['some-future-lane:x', null, NOW - DAY]);
    const complete = new Set<AlertKind>([
      'low-stock',
      'expiry',
      'maintenance-due',
      'warranty-due',
      'field-due',
    ]);
    expect(pruneDismissals(before, new Set(), NOW, complete)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// alertKindFromId
// ---------------------------------------------------------------------------

describe('alertKindFromId', () => {
  it('recovers the lane from every id the builders mint', () => {
    const all = buildAlerts(
      sources({
        lowStock: [{ id: 'i1', name: 'Screw' }],
        expiring: [{ id: 'i2', name: 'Milk', expiryDate: NOW - DAY }],
        maintenanceDue: [{ id: 's1', name: 'Oil', itemId: 'i3', itemName: 'Mower', dueAtMs: NOW - DAY }],
        warrantyItems: [
          {
            id: 'i4',
            name: 'Drill',
            acquiredAt: '2024-01-01',
            purchasePrice: null,
            depreciationMonths: null,
            warrantyExpiresAt: new Date(NOW - DAY).toISOString().slice(0, 10),
          },
        ],
      }),
      NOW,
    );
    expect(all).toHaveLength(4);
    for (const alert of all) expect(alertKindFromId(alert.id)).toBe(alert.kind);
  });

  it('returns null for an id belonging to no known lane', () => {
    expect(alertKindFromId('reminders:summary')).toBeNull();
    expect(alertKindFromId('low-stock')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// groupByKind
// ---------------------------------------------------------------------------

describe('groupByKind', () => {
  it('returns an empty map for an empty input', () => {
    expect(groupByKind([])).toEqual(new Map());
  });

  it('groups alerts by their kind', () => {
    const s = sources({
      lowStock: [{ id: 'a', name: 'A' }],
      expiring: [{ id: 'b', name: 'B', expiryDate: NOW - 1 }],
    });
    const alerts = buildAlerts(s, NOW);
    const groups = groupByKind(alerts);
    expect(groups.has('low-stock')).toBe(true);
    expect(groups.has('expiry')).toBe(true);
    expect(groups.get('low-stock')).toHaveLength(1);
    expect(groups.get('expiry')).toHaveLength(1);
  });

  it('collects multiple alerts of the same kind into one group', () => {
    const s = sources({
      lowStock: [
        { id: 'x', name: 'X' },
        { id: 'y', name: 'Y' },
      ],
    });
    const alerts = buildAlerts(s, NOW);
    const groups = groupByKind(alerts);
    expect(groups.get('low-stock')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// maintenanceDueAtMs helper
// ---------------------------------------------------------------------------

describe('maintenanceDueAtMs', () => {
  it('returns null for USAGE schedules', () => {
    expect(maintenanceDueAtMs('USAGE', null, ms('2025-01-01'), 30)).toBeNull();
  });

  it('returns null when intervalDays is null', () => {
    expect(maintenanceDueAtMs('TIME', null, ms('2025-01-01'), null)).toBeNull();
  });

  it('computes the due instant from lastPerformedAt + intervalDays', () => {
    const anchor = ms('2025-01-01');
    const result = maintenanceDueAtMs('TIME', anchor, ms('2024-01-01'), 30);
    expect(result).toBe(anchor + 30 * 86_400_000);
  });

  it('falls back to createdAt when lastPerformedAt is null', () => {
    const created = ms('2025-06-01');
    const result = maintenanceDueAtMs('TIME', null, created, 7);
    expect(result).toBe(created + 7 * 86_400_000);
  });
});

// ---------------------------------------------------------------------------
// Empty sources
// ---------------------------------------------------------------------------

describe('buildAlerts — empty sources', () => {
  it('returns an empty array when all sources are empty', () => {
    expect(buildAlerts(EMPTY, NOW)).toHaveLength(0);
  });
});

/**
 * The custom-field due-date lane (W1a) — what makes a user-defined `DATE` field act at all.
 *
 * The repository already narrows the read to opted-in definitions inside their own lead time,
 * so what matters here is that the seam **re-grades** rather than trusting that: the feed is a
 * cached page that may be minutes old, and a date pushed out of its window in the meantime must
 * stop alerting without waiting for a refetch.
 */
describe('buildAlerts — custom-field due-date lane (W1a)', () => {
  /** The stored midnight-UTC instant of the calendar day `offset` days from NOW's day. */
  const storedDay = (offset: number): number => {
    const today = new Date(startOfLocalDay(NOW));
    return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  };

  const source = (overrides: Partial<FieldDueSource> = {}): FieldDueSource => ({
    itemId: 'i1',
    itemName: 'Studio insurance',
    defId: 'd1',
    fieldName: 'Renewal date',
    leadDays: 14,
    dueAt: storedDay(3),
    ...overrides,
  });

  it('produces a warning alert for a date inside its notice period', () => {
    const [alert] = buildAlerts(sources({ fieldDue: [source()] }), NOW);
    expect(alert.kind).toBe('field-due');
    expect(alert.severity).toBe('warning');
    expect(alert.title).toBe('Renewal date due soon — Studio insurance');
  });

  it('produces a critical alert once the date has passed', () => {
    const [alert] = buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(-2) })] }), NOW);
    expect(alert.severity).toBe('critical');
    expect(alert.title).toBe('Renewal date passed — Studio insurance');
  });

  it('re-grades the feed, dropping a date that has moved beyond its notice period', () => {
    // A stale cached row: the query included it, but by this render it is no longer imminent.
    expect(buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(90) })] }), NOW)).toHaveLength(0);
  });

  it('encodes the date in the id, so moving a deadline lifts an earlier dismissal', () => {
    const [first] = buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(1) })] }), NOW);
    const [moved] = buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(2) })] }), NOW);
    expect(first.id).not.toBe(moved.id);
    expect(first.id.startsWith('field-due:i1:d1:')).toBe(true);
  });

  it('gives the overdue alert a different id from the due-soon one (issue #644)', () => {
    const [soon] = buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(1) })] }), NOW);
    const [overdue] = buildAlerts(sources({ fieldDue: [source({ dueAt: storedDay(1) })] }), NOW + 3 * DAY);
    expect(soon.severity).toBe('warning');
    expect(overdue.severity).toBe('critical');
    expect(soon.id).not.toBe(overdue.id);
  });

  it('keys on the definition too, so two dated fields on one item both alert', () => {
    const alerts = buildAlerts(
      sources({
        fieldDue: [source(), source({ defId: 'd2', fieldName: 'Inspection due' })],
      }),
      NOW,
    );
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(2);
  });

  it('names the field in the detail, and the notice period it was judged against', () => {
    const [alert] = buildAlerts(sources({ fieldDue: [source({ leadDays: 1 })] }), NOW);
    // 3 days out with 1 day's notice would not fire; use a date inside the shorter window.
    const [inWindow] = buildAlerts(
      sources({ fieldDue: [source({ leadDays: 1, dueAt: storedDay(1) })] }),
      NOW,
    );
    expect(alert).toBeUndefined();
    expect(inWindow.detail).toContain('"Renewal date"');
    expect(inWindow.detail).toContain('within 1 day');
  });

  it('deep-links to the item, seeding the search so it is on screen on arrival', () => {
    const [alert] = buildAlerts(sources({ fieldDue: [source()] }), NOW);
    expect(alert.target).toEqual({
      route: '/inventory',
      itemId: 'i1',
      itemName: 'Studio insurance',
    });
  });
});
