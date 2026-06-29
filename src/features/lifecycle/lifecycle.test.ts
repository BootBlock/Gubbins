import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { expiryStatus, daysUntilExpiry } from './expiry';
import { validateVariantLink, variantRejectionMessage } from './variants';
import {
  maintenanceStatus,
  maintenancePerformedNote,
  checkoutHours,
  accruedCheckoutHours,
  effectiveUsage,
} from './maintenance';
import {
  variances,
  varianceCount,
  lineVariance,
  reconciliationNote,
  serialisedLabel,
  missingInstances,
  serialisedAuditNote,
  type SerialisedAuditLine,
  type SerialisedPresence,
} from './cycle-count';

const NOW = 1_700_000_000_000;

describe('expiry status (§4 Perishables)', () => {
  it('returns NONE when no expiry date is set', () => {
    expect(expiryStatus(null, NOW)).toBe('NONE');
    expect(expiryStatus(undefined, NOW)).toBe('NONE');
    expect(daysUntilExpiry(null, NOW)).toBeNull();
  });

  it('classifies expired (inclusive of exactly now)', () => {
    expect(expiryStatus(NOW, NOW)).toBe('EXPIRED');
    expect(expiryStatus(NOW - MS_PER_DAY, NOW)).toBe('EXPIRED');
  });

  it('classifies expiring soon within the window and fresh beyond it', () => {
    expect(expiryStatus(NOW + 5 * MS_PER_DAY, NOW)).toBe('EXPIRING_SOON');
    expect(expiryStatus(NOW + 29 * MS_PER_DAY, NOW)).toBe('EXPIRING_SOON');
    expect(expiryStatus(NOW + 40 * MS_PER_DAY, NOW)).toBe('FRESH');
  });

  it('honours a custom window', () => {
    expect(expiryStatus(NOW + 5 * MS_PER_DAY, NOW, 3)).toBe('FRESH');
    expect(expiryStatus(NOW + 2 * MS_PER_DAY, NOW, 3)).toBe('EXPIRING_SOON');
  });

  it('computes whole days until expiry, negative once past', () => {
    expect(daysUntilExpiry(NOW + 3 * MS_PER_DAY, NOW)).toBe(3);
    expect(daysUntilExpiry(NOW - 2 * MS_PER_DAY, NOW)).toBe(-2);
    // 12 hours out floors to 0 — "expires within a day".
    expect(daysUntilExpiry(NOW + MS_PER_DAY / 2, NOW)).toBe(0);
  });
});

describe('variant link validation (§4 Variant/SKU, §7.5.3 cycle rejection — multi-level)', () => {
  const base = {
    childId: 'c',
    parentId: 'p',
    parentAncestorIds: ['p'] as string[],
  };

  it('accepts a valid link', () => {
    expect(validateVariantLink(base)).toBeNull();
  });

  it('accepts nesting under an item that is itself a variant (multi-level)', () => {
    // Phase 18 lifts the single-level rule: a variant may itself be a parent, so
    // a grandparent chain (p is a child of g) is valid as long as no cycle forms.
    expect(validateVariantLink({ ...base, parentAncestorIds: ['p', 'g'] })).toBeNull();
  });

  it('rejects self-parenting', () => {
    expect(validateVariantLink({ ...base, parentId: 'c', parentAncestorIds: ['c'] })).toBe('SELF_PARENT');
  });

  it('rejects a cycle when the child is in the parent ancestry', () => {
    expect(validateVariantLink({ ...base, parentAncestorIds: ['p', 'x', 'c'] })).toBe('CYCLE');
  });

  it('gives a British-English message for every rejection', () => {
    for (const reason of ['SELF_PARENT', 'CYCLE'] as const) {
      expect(variantRejectionMessage(reason).length).toBeGreaterThan(0);
    }
  });
});

describe('maintenance scheduling (§4.3)', () => {
  it('TIME schedule is due once the interval elapses from last service', () => {
    const lastPerformedAt = NOW - 100 * MS_PER_DAY;
    const overdue = maintenanceStatus(
      { basis: 'TIME', intervalDays: 90, intervalUsage: null, usageSinceService: 0, lastPerformedAt, createdAt: 0 },
      NOW,
    );
    expect(overdue.due).toBe(true);
    expect(overdue.remainingDays).toBe(-10);
    expect(overdue.dueAt).toBe(lastPerformedAt + 90 * MS_PER_DAY);

    const fresh = maintenanceStatus(
      { basis: 'TIME', intervalDays: 90, intervalUsage: null, usageSinceService: 0, lastPerformedAt: NOW - 10 * MS_PER_DAY, createdAt: 0 },
      NOW,
    );
    expect(fresh.due).toBe(false);
    expect(fresh.remainingDays).toBe(80);
  });

  it('TIME schedule anchors on createdAt when never serviced', () => {
    const status = maintenanceStatus(
      { basis: 'TIME', intervalDays: 30, intervalUsage: null, usageSinceService: 0, lastPerformedAt: null, createdAt: NOW - 31 * MS_PER_DAY },
      NOW,
    );
    expect(status.due).toBe(true);
  });

  it('USAGE schedule is due once accrued usage reaches the interval', () => {
    const due = maintenanceStatus(
      { basis: 'USAGE', intervalDays: null, intervalUsage: 100, usageSinceService: 100, lastPerformedAt: null, createdAt: 0 },
      NOW,
    );
    expect(due.due).toBe(true);
    expect(due.remainingUsage).toBe(0);

    const notYet = maintenanceStatus(
      { basis: 'USAGE', intervalDays: null, intervalUsage: 100, usageSinceService: 60, lastPerformedAt: null, createdAt: 0 },
      NOW,
    );
    expect(notYet.due).toBe(false);
    expect(notYet.remainingUsage).toBe(40);
  });

  it('composes a performed note for both bases', () => {
    expect(
      maintenancePerformedNote(
        'Lubricate rails',
        { basis: 'USAGE', intervalDays: null, intervalUsage: 100, usageSinceService: 112, lastPerformedAt: null, createdAt: 0 },
        NOW,
      ),
    ).toContain('112');
    expect(
      maintenancePerformedNote(
        'Calibrate',
        { basis: 'TIME', intervalDays: 90, intervalUsage: null, usageSinceService: 0, lastPerformedAt: NOW - 100 * MS_PER_DAY, createdAt: 0 },
        NOW,
      ),
    ).toContain('overdue');
  });
});

describe('maintenance checkout-hours telemetry (§4.3, Phase 22)', () => {
  const HOUR = 3_600_000;

  it('checkoutHours measures a returned loan and clamps clock skew', () => {
    expect(checkoutHours({ checkedOutAt: NOW, returnedAt: NOW + 5 * HOUR }, NOW + 9 * HOUR)).toBe(5);
    // Still out → accrues up to now.
    expect(checkoutHours({ checkedOutAt: NOW, returnedAt: null }, NOW + 3 * HOUR)).toBe(3);
    // Returned before checked out (skew) never goes negative.
    expect(checkoutHours({ checkedOutAt: NOW, returnedAt: NOW - HOUR }, NOW)).toBe(0);
  });

  it('accruedCheckoutHours sums only loans begun at/after the service anchor', () => {
    const anchor = NOW;
    const windows = [
      { checkedOutAt: NOW - 10 * HOUR, returnedAt: NOW - 5 * HOUR }, // before anchor → ignored
      { checkedOutAt: NOW, returnedAt: NOW + 2 * HOUR }, // 2h
      { checkedOutAt: NOW + 4 * HOUR, returnedAt: null }, // still out → 3h at now+7h
    ];
    expect(accruedCheckoutHours(windows, anchor, NOW + 7 * HOUR)).toBe(5);
    expect(accruedCheckoutHours([], anchor, NOW)).toBe(0);
  });

  it('accruedCheckoutHours scoped to a location counts only loans drawn from it (Phase 30)', () => {
    const anchor = NOW;
    const windows = [
      { checkedOutAt: NOW + 1 * HOUR, returnedAt: NOW + 3 * HOUR, sourceLocationId: 'bench' }, // 2h
      { checkedOutAt: NOW + 4 * HOUR, returnedAt: NOW + 9 * HOUR, sourceLocationId: 'store' }, // 5h elsewhere
      { checkedOutAt: NOW + 5 * HOUR, returnedAt: NOW + 6 * HOUR, sourceLocationId: null }, // unknown source
    ];
    // Item-level (no scope) sums every loan; bench-scoped counts only the bench loan.
    expect(accruedCheckoutHours(windows, anchor, NOW + 10 * HOUR)).toBe(8);
    expect(accruedCheckoutHours(windows, anchor, NOW + 10 * HOUR, 'bench')).toBe(2);
    expect(accruedCheckoutHours(windows, anchor, NOW + 10 * HOUR, 'store')).toBe(5);
    // A scope with no matching loans accrues nothing.
    expect(accruedCheckoutHours(windows, anchor, NOW + 10 * HOUR, 'attic')).toBe(0);
  });

  it('effectiveUsage reads derived hours when accruing, else the manual counter', () => {
    expect(
      effectiveUsage({
        basis: 'USAGE', intervalDays: null, intervalUsage: 100,
        usageSinceService: 40, accrueCheckoutHours: true, autoUsage: 73,
        lastPerformedAt: null, createdAt: 0,
      }),
    ).toBe(73);
    expect(
      effectiveUsage({
        basis: 'USAGE', intervalDays: null, intervalUsage: 100,
        usageSinceService: 40, accrueCheckoutHours: false, autoUsage: 73,
        lastPerformedAt: null, createdAt: 0,
      }),
    ).toBe(40);
  });

  it('USAGE due-ness and the performed note honour derived checkout-hours', () => {
    const state = {
      basis: 'USAGE' as const, intervalDays: null, intervalUsage: 100,
      usageSinceService: 0, accrueCheckoutHours: true, autoUsage: 105,
      lastPerformedAt: null, createdAt: 0,
    };
    const status = maintenanceStatus(state, NOW);
    expect(status.due).toBe(true);
    expect(status.remainingUsage).toBe(-5);
    expect(maintenancePerformedNote('Service motor', state, NOW)).toContain('105h of loan usage');
  });
});

describe('cycle-count variance (§4.4)', () => {
  const lines = [
    { itemId: 'a', name: 'Widget', expected: 10, counted: 8 },
    { itemId: 'b', name: 'Gadget', expected: 5, counted: 5 },
    { itemId: 'c', name: 'Sprocket', expected: 2, counted: 4 },
  ];

  it('computes signed variance per line', () => {
    expect(lineVariance(lines[0])).toBe(-2);
    expect(lineVariance(lines[2])).toBe(2);
  });

  it('returns only drifted lines, annotated', () => {
    const drift = variances(lines);
    expect(drift).toHaveLength(2);
    expect(drift.map((l) => l.itemId)).toEqual(['a', 'c']);
    expect(drift[0].variance).toBe(-2);
    expect(varianceCount(lines)).toBe(2);
  });

  it('composes a reconciliation note', () => {
    const drift = variances(lines);
    expect(reconciliationNote(drift[0], 'Drawer A2')).toBe(
      'Cycle count of Drawer A2: counted 8, expected 10 (adjustment -2).',
    );
    expect(reconciliationNote(drift[1], 'Drawer A2')).toContain('adjustment +2');
  });
});

describe('serialised audit (§4.4)', () => {
  const lines: SerialisedAuditLine[] = [
    { itemId: 'a', name: 'Multimeter', serialNo: 1 },
    { itemId: 'b', name: 'Multimeter', serialNo: 2 },
    { itemId: 'c', name: 'Oscilloscope', serialNo: null },
  ];

  it('labels an instance with its serial number, falling back to the bare name', () => {
    expect(serialisedLabel(lines[0])).toBe('Multimeter #1');
    expect(serialisedLabel(lines[2])).toBe('Oscilloscope');
  });

  it('returns only the explicitly-missing instances, never present or untouched ones', () => {
    const presence: Record<string, SerialisedPresence> = { a: 'PRESENT', b: 'MISSING' };
    const missing = missingInstances(lines, presence);
    expect(missing.map((l) => l.itemId)).toEqual(['b']);
  });

  it('treats an empty presence map as nothing missing (no accidental soft-deletes)', () => {
    expect(missingInstances(lines, {})).toHaveLength(0);
  });

  it('composes a serialised-audit ledger note', () => {
    expect(serialisedAuditNote(lines[1], 'Drawer A2')).toBe(
      'Serialised audit of Drawer A2: Multimeter #2 not found — marked missing.',
    );
  });
});
