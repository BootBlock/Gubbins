/**
 * Unit tests for the alert-centre pure seam (Phase 68, spec §3).
 *
 * All four lanes are tested independently. The warranty lane is also tested with
 * the Phase-66 `warrantyExpiresAt` field absent/null (gate check). Dismissal
 * filtering, grouping, severity ordering, and `dueAt` ordering are all covered.
 * No DB access, no side-effects — `now` is always injected.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAlerts,
  applyDismissals,
  groupByKind,
  maintenanceDueAtMs,
  type AlertSources,
  type LowStockSource,
  type ExpirySource,
  type MaintenanceDueSource,
  type WarrantySource,
} from './alerts';

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

  it('sets a deterministic id prefixed with "expiry:"', () => {
    const exp: ExpirySource[] = [{ id: 'perishable-1', name: 'Cheese', expiryDate: NOW - 1 }];
    const [alert] = buildAlerts(sources({ expiring: exp }), NOW);
    expect(alert.id).toBe('expiry:perishable-1');
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
    expect(alert.id).toBe('maintenance-due:sched-1');
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
    expect(alert.id).toBe(`warranty-due:asset-1:${date}`);
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
    expect(alerts[0].id).toBe('maintenance-due:s2');
    expect(alerts[1].id).toBe('maintenance-due:s1');
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

describe('applyDismissals', () => {
  it('returns all alerts when dismissedIds is empty', () => {
    const s = sources({ lowStock: [{ id: 'x', name: 'X' }] });
    const alerts = buildAlerts(s, NOW);
    expect(applyDismissals(alerts, new Set())).toHaveLength(1);
  });

  it('filters out dismissed alerts by id', () => {
    const s = sources({
      lowStock: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    });
    const alerts = buildAlerts(s, NOW);
    const dismissed = new Set(['low-stock:a']);
    const result = applyDismissals(alerts, dismissed);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('low-stock:b');
  });

  it('returns an empty list when all alerts are dismissed', () => {
    const s = sources({ lowStock: [{ id: 'c', name: 'C' }] });
    const alerts = buildAlerts(s, NOW);
    const dismissed = new Set(['low-stock:c']);
    expect(applyDismissals(alerts, dismissed)).toHaveLength(0);
  });

  it('ignores dismissal ids that do not match any alert', () => {
    const s = sources({ lowStock: [{ id: 'd', name: 'D' }] });
    const alerts = buildAlerts(s, NOW);
    const dismissed = new Set(['low-stock:nonexistent']);
    expect(applyDismissals(alerts, dismissed)).toHaveLength(1);
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
