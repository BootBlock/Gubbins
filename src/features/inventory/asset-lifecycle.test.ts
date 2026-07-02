import { describe, it, expect } from 'vitest';
import {
  warrantyStatus,
  currentValue,
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
// warrantyStatus
// ---------------------------------------------------------------------------

describe('warrantyStatus', () => {
  it('returns "none" when warrantyExpiresAt is null', () => {
    expect(warrantyStatus(item(), Date.now())).toBe('none');
  });

  it('returns "none" when warrantyExpiresAt is not a parseable date', () => {
    expect(warrantyStatus(item({ warrantyExpiresAt: 'not-a-date' }), Date.now())).toBe('none');
  });

  it('returns "expired" when now is past the expiry date', () => {
    const expiry = ms('2024-01-01');
    // "now" is one day after expiry (past midnight, so strictly greater)
    const now = expiry + 86_400_000;
    expect(warrantyStatus(item({ warrantyExpiresAt: '2024-01-01' }), now)).toBe('expired');
  });

  it('returns "expired" when now is exactly one millisecond past the expiry', () => {
    const expiry = ms('2025-06-01');
    expect(warrantyStatus(item({ warrantyExpiresAt: '2025-06-01' }), expiry + 1)).toBe('expired');
  });

  it('returns "expiring-soon" when now is exactly at the expiry instant (0 days remain)', () => {
    const expiry = ms('2025-06-01');
    // now === expiryMs: not yet past (not expired), but daysRemaining = 0 ≤ 30 → expiring-soon.
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
