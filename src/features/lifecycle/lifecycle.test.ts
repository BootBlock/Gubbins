import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { expiryStatus, daysUntilExpiry } from './expiry';
import { validateVariantLink, variantRejectionMessage } from './variants';
import { maintenanceStatus, maintenancePerformedNote } from './maintenance';
import { variances, varianceCount, lineVariance, reconciliationNote } from './cycle-count';

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

describe('variant link validation (§4 Variant/SKU, §7.5.3 cycle rejection)', () => {
  const base = {
    childId: 'c',
    parentId: 'p',
    parentIsVariant: false,
    childHasVariants: false,
    parentAncestorIds: [] as string[],
  };

  it('accepts a valid single-level link', () => {
    expect(validateVariantLink(base)).toBeNull();
  });

  it('rejects self-parenting', () => {
    expect(validateVariantLink({ ...base, parentId: 'c' })).toBe('SELF_PARENT');
  });

  it('rejects a cycle when the child is in the parent ancestry', () => {
    expect(validateVariantLink({ ...base, parentAncestorIds: ['x', 'c'] })).toBe('CYCLE');
  });

  it('rejects nesting under an existing variant', () => {
    expect(validateVariantLink({ ...base, parentIsVariant: true })).toBe('PARENT_IS_VARIANT');
  });

  it('rejects making a parent item a variant', () => {
    expect(validateVariantLink({ ...base, childHasVariants: true })).toBe('CHILD_HAS_VARIANTS');
  });

  it('gives a British-English message for every rejection', () => {
    for (const reason of ['SELF_PARENT', 'CYCLE', 'PARENT_IS_VARIANT', 'CHILD_HAS_VARIANTS'] as const) {
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
