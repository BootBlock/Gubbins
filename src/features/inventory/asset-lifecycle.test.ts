import { describe, it, expect } from 'vitest';
import {
  warrantyStatus,
  currentValue,
  warrantyExpiryFromWindow,
  WARRANTY_EXPIRING_SOON_DAYS,
  type AssetLifecycleItem,
} from './asset-lifecycle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AssetLifecycleItem with only the fields under test set. */
function item(overrides: Partial<AssetLifecycleItem> = {}): AssetLifecycleItem {
  return {
    acquiredAt: null,
    warrantyExpiresAt: null,
    purchasePrice: null,
    depreciationMonths: null,
    ...overrides,
  };
}

/**
 * Parse `YYYY-MM-DD` to a UNIX-ms instant (midnight UTC), matching the
 * `fromDateInputValue` wire format used throughout the app.
 */
function ms(date: string): number {
  return Date.parse(date);
}

// ---------------------------------------------------------------------------
// warrantyExpiryFromWindow (backlog T2 — category-default warranty window)
// ---------------------------------------------------------------------------

describe('warrantyExpiryFromWindow', () => {
  const now = ms('2026-07-10');

  it('measures the window from the acquired date when one is set', () => {
    expect(warrantyExpiryFromWindow('2026-01-15', 24, now)).toBe('2028-01-15');
    expect(warrantyExpiryFromWindow('2026-01-15', 12, now)).toBe('2027-01-15');
  });

  it('measures the window from today when no acquired date is set', () => {
    expect(warrantyExpiryFromWindow(null, 12, now)).toBe('2027-07-10');
    expect(warrantyExpiryFromWindow('   ', 6, now)).toBe('2027-01-10');
  });

  it('clamps the day to the last of a shorter target month', () => {
    // 31 Jan + 1 month has no 31 Feb — it clamps to the last day of February.
    expect(warrantyExpiryFromWindow('2026-01-31', 1, now)).toBe('2026-02-28');
    // Leap year: Feb 2028 has 29 days.
    expect(warrantyExpiryFromWindow('2028-01-31', 1, now)).toBe('2028-02-29');
  });

  it('returns null for a non-positive or invalid window', () => {
    expect(warrantyExpiryFromWindow('2026-01-15', 0, now)).toBeNull();
    expect(warrantyExpiryFromWindow('2026-01-15', -3, now)).toBeNull();
    expect(warrantyExpiryFromWindow('2026-01-15', Number.NaN, now)).toBeNull();
  });

  it('falls back to today when the acquired date is unparseable', () => {
    expect(warrantyExpiryFromWindow('not-a-date', 12, now)).toBe('2027-07-10');
  });
});

// ---------------------------------------------------------------------------
// warrantyStatus
// ---------------------------------------------------------------------------

describe('warrantyStatus', () => {
  it('returns "none" when warrantyExpiresAt is null', () => {
    expect(warrantyStatus(item(), Date.now())).toBe('none');
  });

  it('returns "none" when warrantyExpiresAt is not a parseable date', () => {
    expect(warrantyStatus(item({ warrantyExpiresAt: 'not-a-date' }), Date.now())).toBe('none');
  });

  it('returns "expired" once the local day is past the expiry day', () => {
    // "now" is local midnight of the day after the expiry day → the expiry day has fully passed.
    // Local wall-clock instants keep this correct in any host zone (the worker's own zone is not UTC).
    const now = new Date(2024, 0, 2, 0, 0, 0, 0).getTime(); // local 2 Jan 2024
    expect(warrantyStatus(item({ warrantyExpiresAt: '2024-01-01' }), now)).toBe('expired');
  });

  it('stays unexpired all through the expiry day, flipping only at the next local day (issue #319)', () => {
    // Late on the expiry day (local) it is not yet expired; the transition waits for the next local
    // calendar day — never the evening before, as a raw `now > expiryMs` compare would flag.
    const lateOnExpiryDay = new Date(2025, 5, 1, 23, 59, 59, 999).getTime(); // local 1 Jun 2025
    const nextDay = new Date(2025, 5, 2, 0, 0, 0, 0).getTime(); // local 2 Jun 2025
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-06-01' }), lateOnExpiryDay)).toBe('expiring-soon');
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-06-01' }), nextDay)).toBe('expired');
  });

  it('returns "expiring-soon" when now is exactly at the expiry instant (0 days remain)', () => {
    const expiry = ms('2025-06-01');
    // now === expiryMs: the expiry day has not yet passed (not expired), but daysRemaining = 0 ≤ 30.
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-06-01' }), expiry)).toBe('expiring-soon');
  });

  it('returns "expiring-soon" when expiry is within the window', () => {
    const expiry = ms('2025-07-30');
    // now is 15 days before expiry — well within the 30-day window
    const now = expiry - 15 * 86_400_000;
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-07-30' }), now)).toBe('expiring-soon');
  });

  it('returns "expiring-soon" when days remaining equals the window boundary exactly', () => {
    const expiry = ms('2025-08-01');
    // Exactly WARRANTY_EXPIRING_SOON_DAYS days away in ms
    const now = expiry - WARRANTY_EXPIRING_SOON_DAYS * 86_400_000;
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-08-01' }), now)).toBe('expiring-soon');
  });

  it('returns "active" when now is one day outside the expiring-soon window', () => {
    const expiry = ms('2025-09-01');
    const now = expiry - (WARRANTY_EXPIRING_SOON_DAYS + 1) * 86_400_000;
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-09-01' }), now)).toBe('active');
  });

  it('returns "active" for a warranty expiring a year from now', () => {
    const now = ms('2025-01-01');
    expect(warrantyStatus(item({ warrantyExpiresAt: '2026-01-01' }), now)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// currentValue
// ---------------------------------------------------------------------------

describe('currentValue', () => {
  it('returns null when purchase_price is null (widget hidden)', () => {
    expect(currentValue(item(), Date.now())).toBeNull();
  });

  it('returns the purchase price when there are no depreciation_months (no depreciation)', () => {
    const i = item({ purchasePrice: 500 });
    expect(currentValue(i, ms('2025-06-15'))).toBeCloseTo(500);
  });

  it('returns the purchase price when acquired_at is null (depreciation not started)', () => {
    const i = item({ purchasePrice: 300, depreciationMonths: 24 });
    expect(currentValue(i, ms('2025-06-15'))).toBeCloseTo(300);
  });

  it('returns the full purchase price at t=0 (acquired today)', () => {
    const acquiredAt = '2025-06-15';
    const now = ms(acquiredAt);
    const i = item({ purchasePrice: 1200, acquiredAt, depreciationMonths: 36 });
    expect(currentValue(i, now)).toBeCloseTo(1200);
  });

  it('returns half the purchase price at the midpoint of useful life', () => {
    // 24-month useful life; 12 months elapsed ≈ midpoint
    const acquiredAt = '2024-01-01';
    // Approximately 12 months later (365.25/2 days)
    const nowMs = ms(acquiredAt) + 12 * (365.25 / 12) * 86_400_000;
    const i = item({ purchasePrice: 1000, acquiredAt, depreciationMonths: 24 });
    const value = currentValue(i, nowMs);
    expect(value).not.toBeNull();
    // Should be ~500 at the midpoint
    expect(value!).toBeCloseTo(500, 0);
  });

  it('floors at 0 when the asset has fully depreciated (past end of useful life)', () => {
    const acquiredAt = '2020-01-01';
    // 5 years after acquisition, useful life was 36 months → fully depreciated
    const now = ms('2025-01-01');
    const i = item({ purchasePrice: 800, acquiredAt, depreciationMonths: 36 });
    const value = currentValue(i, now);
    expect(value).not.toBeNull();
    expect(value!).toBe(0);
  });

  it('returns 0 for a very long time past the end of useful life', () => {
    const acquiredAt = '2000-01-01';
    const now = ms('2025-06-30');
    const i = item({ purchasePrice: 500, acquiredAt, depreciationMonths: 12 });
    expect(currentValue(i, now)).toBe(0);
  });

  it('handles a non-parseable acquired_at gracefully (returns purchase price)', () => {
    const i = item({ purchasePrice: 200, acquiredAt: 'not-a-date', depreciationMonths: 12 });
    expect(currentValue(i, ms('2025-06-15'))).toBeCloseTo(200);
  });

  it('computes a plausible residual at three-quarters of useful life', () => {
    const acquiredAt = '2023-01-01';
    // 36-month life; 27 months elapsed → 75% through → 25% residual
    const nowMs = ms(acquiredAt) + 27 * (365.25 / 12) * 86_400_000;
    const i = item({ purchasePrice: 400, acquiredAt, depreciationMonths: 36 });
    const value = currentValue(i, nowMs);
    expect(value).not.toBeNull();
    // Expect approximately 100 (25% of 400)
    expect(value!).toBeCloseTo(100, 0);
  });

  it('does not depreciate a zero-price item (returns 0, not null)', () => {
    const i = item({ purchasePrice: 0, acquiredAt: '2024-01-01', depreciationMonths: 12 });
    expect(currentValue(i, ms('2025-06-15'))).toBeCloseTo(0);
  });
});
