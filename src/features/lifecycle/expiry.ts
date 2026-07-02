/**
 * Perishable expiry maths (spec §4 Perishables & Batch Tracking, §3 "Soon to
 * Expire" widget), kept pure and isolated. Shared by the repository (classifying
 * rows on read), the dashboard widget and the passive toast nudges. All instants
 * are UNIX epoch milliseconds, matching `items.expiry_date`.
 */
import { EXPIRY_SOON_WINDOW_DAYS, MS_PER_DAY } from '@/db/repositories/constants';

/**
 * Expiry classification of a perishable item:
 * - `NONE` — no expiry date set (not a perishable / untracked).
 * - `FRESH` — expires beyond the "soon" window.
 * - `EXPIRING_SOON` — expires within the window (default {@link EXPIRY_SOON_WINDOW_DAYS}).
 * - `EXPIRED` — the expiry instant has passed (inclusive of exactly now).
 */
export type ExpiryStatus = 'NONE' | 'FRESH' | 'EXPIRING_SOON' | 'EXPIRED';

export function expiryStatus(
  expiryDate: number | null | undefined,
  now: number,
  windowDays: number = EXPIRY_SOON_WINDOW_DAYS,
): ExpiryStatus {
  if (expiryDate == null) return 'NONE';
  if (expiryDate <= now) return 'EXPIRED';
  if (expiryDate - now <= windowDays * MS_PER_DAY) return 'EXPIRING_SOON';
  return 'FRESH';
}

/**
 * Whole days until expiry (negative once expired). Rounded *down* so "0 days"
 * means it expires within the next 24 hours; a fresh item one full day out reads
 * "1". Returns `null` when no expiry date is set.
 */
export function daysUntilExpiry(expiryDate: number | null | undefined, now: number): number | null {
  if (expiryDate == null) return null;
  return Math.floor((expiryDate - now) / MS_PER_DAY);
}
