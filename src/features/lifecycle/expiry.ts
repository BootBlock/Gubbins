/**
 * Perishable expiry maths (spec §4 Perishables & Batch Tracking, §3 "Soon to
 * Expire" widget), kept pure and isolated. Shared by the repository (classifying
 * rows on read), the dashboard widget and the passive toast nudges. All instants
 * are UNIX epoch milliseconds, matching `items.expiry_date`.
 */
import { EXPIRY_SOON_WINDOW_DAYS, MS_PER_DAY } from '@/db/repositories/constants';
import { addCalendarDays, startOfLocalDay, utcDayToLocalDay } from '@/lib/calendar-days';

/**
 * Expiry classification of a perishable item:
 * - `NONE` — no expiry date set (not a perishable / untracked).
 * - `FRESH` — expires beyond the "soon" window.
 * - `EXPIRING_SOON` — expires within the window (default {@link EXPIRY_SOON_WINDOW_DAYS}).
 * - `EXPIRED` — the expiry *day* has passed in the viewer's local zone (issue #319).
 */
export type ExpiryStatus = 'NONE' | 'FRESH' | 'EXPIRING_SOON' | 'EXPIRED';

/**
 * The date an item is judged to expire on: the earlier of its own `expiryDate` and the earliest
 * date across its lots that still hold stock, or `null` when it has neither (issue #684).
 *
 * The pure twin of `effectiveExpirySql`, and the seam every expiry surface reads. An item can be
 * perishable purely through its lots — the purchase-order and BOM receipts record a batch date,
 * not an item one — so reading `expiryDate` alone drops exactly the rows the SQL predicate went
 * to the trouble of finding.
 *
 * Takes the two dates rather than a whole `Item` so the alert and agenda projections, which
 * narrow an item down to a handful of fields before classifying it, can call it on either shape.
 */
export function effectiveExpiryDate(
  expiryDate: number | null | undefined,
  earliestBatchExpiryDate: number | null | undefined,
): number | null {
  if (expiryDate == null) return earliestBatchExpiryDate ?? null;
  if (earliestBatchExpiryDate == null) return expiryDate;
  return Math.min(expiryDate, earliestBatchExpiryDate);
}

export function expiryStatus(
  expiryDate: number | null | undefined,
  now: number,
  windowDays: number = EXPIRY_SOON_WINDOW_DAYS,
): ExpiryStatus {
  if (expiryDate == null) return 'NONE';
  // `expiry_date` is a day-grained midnight-UTC stamp (#320); it is EXPIRED once the viewer's local
  // calendar day is past the stored day — never the evening before it, as a raw `<= now` instant
  // compare would (issue #319). Re-anchor the stored day onto the local calendar (utcDayToLocalDay,
  // issue #323) and compare local days, so a best-before "20 July" is still fresh all through 20 July
  // local.
  if (utcDayToLocalDay(expiryDate) < startOfLocalDay(now)) return 'EXPIRED';
  // Calendar-day window (issue #325): "expires within N days" measures whole calendar days from
  // now, matching the `expiringPredicateSql` cutoff the repository binds, so the pure classifier
  // and the SQL pre-filter agree even across a DST change.
  if (expiryDate <= addCalendarDays(now, windowDays)) return 'EXPIRING_SOON';
  return 'FRESH';
}

/**
 * Whole *calendar* days until expiry in the viewer's local zone (negative once expired), so it
 * agrees with {@link expiryStatus}'s local-day boundary (issue #319): `0` means it expires **today**
 * (its stored day is the viewer's current day), `1` means tomorrow, and `< 0` exactly when EXPIRED.
 * Both operands are re-anchored to local midnight (`utcDayToLocalDay(expiryDate)` and
 * `startOfLocalDay(now)`) and rounded, since two local midnights can be 23/25h apart across a DST
 * change (issue #325). Returns `null` when no expiry date is set.
 */
export function daysUntilExpiry(expiryDate: number | null | undefined, now: number): number | null {
  if (expiryDate == null) return null;
  return Math.round((utcDayToLocalDay(expiryDate) - startOfLocalDay(now)) / MS_PER_DAY);
}
