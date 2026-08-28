/**
 * Asset lifecycle pure logic (Phase 66, spec §4 asset facet).
 *
 * Straight-line depreciation and warranty-status derivation from the four nullable
 * `items` asset columns: `acquired_at`, `warranty_expires_at`,
 * `purchase_price`, `depreciation_months`. All functions are **pure** — they take
 * an item-shaped slice and a `now` instant; no DB access, no side effects — so they
 * are exhaustively unit-testable in isolation (same "logic out of glue" seam as
 * `reorder-policy.ts`, `cycle-count.ts`).
 */

import { WARRANTY_SOON_WINDOW_DAYS } from '@/db/repositories/constants';
import { localDayWindowCutoff, startOfLocalDay, utcDayToLocalDay } from '@/lib/calendar-days';

/**
 * Days before warranty expiry at which status changes from `active` to `expiring-soon`.
 * Aliases the db-layer {@link WARRANTY_SOON_WINDOW_DAYS} so the alert centre, the
 * `listWarrantyExpiring` feed and the inventory "Warranty" status filter share one window.
 */
export const WARRANTY_EXPIRING_SOON_DAYS = WARRANTY_SOON_WINDOW_DAYS;

/** Warranty status values from narrowest to widest concern. */
export type WarrantyStatus = 'active' | 'expiring-soon' | 'expired' | 'none';

/**
 * The asset-relevant slice of an item — kept minimal so callers can pass any shape
 * that carries these four fields.
 */
export interface AssetLifecycleItem {
  readonly acquiredAt: string | null;
  readonly warrantyExpiresAt: string | null;
  readonly purchasePrice: number | null;
  readonly depreciationMonths: number | null;
}

/**
 * Derive the warranty status for an item given the current wall-clock date.
 *
 * - `'none'`           — no `warranty_expires_at` is set; the widget is hidden.
 * - `'expired'`        — the viewer's local calendar day is past the warranty expiry day (issue #319).
 * - `'expiring-soon'`  — the warranty expires within {@link WARRANTY_EXPIRING_SOON_DAYS} days.
 * - `'active'`         — the warranty is valid and not imminently expiring.
 *
 * The `now` parameter is a UNIX-ms instant (injected for testability, matching the
 * convention used by `expiryStatus` in `expiry.ts`).
 */
export function warrantyStatus(item: AssetLifecycleItem, now: number): WarrantyStatus {
  if (item.warrantyExpiresAt == null) return 'none';

  // Parse as midnight UTC; toISOString slice is the reverse of toDateInputValue.
  const expiryMs = Date.parse(item.warrantyExpiresAt);
  if (!Number.isFinite(expiryMs)) return 'none';

  // `warranty_expires_at` names a calendar day (a `YYYY-MM-DD` stamp parsed as midnight UTC); it is
  // expired once the viewer's local day is past that day, not the evening before as a raw `now >
  // expiryMs` instant compare would flag for a zone behind UTC (issue #319). Re-anchor the stored day
  // onto the local calendar (utcDayToLocalDay, issue #323) and compare local days.
  if (utcDayToLocalDay(expiryMs) < startOfLocalDay(now)) return 'expired';

  // Calendar-day window (issues #325, #498), mirroring `expiryStatus`: the warranty is
  // expiring-soon once its expiry day is within N whole calendar days of *today*.
  // `localDayWindowCutoff` anchors the window at local midnight and returns the boundary day in the
  // midnight-UTC frame `expiryMs` was parsed into, so both sides name days — measuring from the
  // wall-clock instant instead made the badge flip between active and expiring-soon as the day went
  // on. The same call binds the `warrantyExpiringPredicateSql` cutoff.
  if (expiryMs <= localDayWindowCutoff(now, WARRANTY_EXPIRING_SOON_DAYS)) return 'expiring-soon';

  return 'active';
}

/**
 * Turn a warranty *window* (a whole number of months) into an absolute expiry date
 * (`YYYY-MM-DD`), the shape `items.warranty_expires_at` stores. Used by the create form to
 * apply a category-template default warranty window (backlog T2): the window is measured
 * from the item's acquisition date when one is set, else from `now` (treating the item as
 * just acquired), so a "12-month warranty" category default lands a concrete expiry date.
 *
 * Calendar-month arithmetic (not a fixed 30-day approximation): `+ N months` advances the
 * month, clamping the day to the last of the target month for short months (e.g. 31 Jan
 * + 1 month → 28/29 Feb). All maths is done in UTC to match `warrantyStatus`'s date parsing
 * and avoid a local-timezone off-by-one. Returns `null` for a non-positive/invalid window.
 */
export function warrantyExpiryFromWindow(
  acquiredAt: string | null,
  months: number,
  now: number,
): string | null {
  if (!Number.isFinite(months) || months <= 0) return null;
  const wholeMonths = Math.trunc(months);

  // Base date: the acquisition date (parsed as UTC midnight, like `warrantyStatus`) when set
  // and valid, else today. A blank/garbled acquired date falls back to `now`.
  const acquiredMs = acquiredAt && acquiredAt.trim() ? Date.parse(acquiredAt) : NaN;
  const base = new Date(Number.isFinite(acquiredMs) ? acquiredMs : now);

  const day = base.getUTCDate();
  // Anchor on day 1 of the target month so a JS day-overflow can't roll into the next month,
  // then clamp the day to that month's length.
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + wholeMonths, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));

  return target.toISOString().slice(0, 10);
}

/**
 * Milliseconds in one depreciation month — a continuous fraction of the mean Gregorian year
 * (365.25 days / 12 ≈ 30.4375 days), not a calendar month, so a term runs down smoothly rather
 * than in twelve unequal steps.
 *
 * Exported because {@link currentValue} is no longer the only place the straight-line formula is
 * evaluated: the valuation reads state it again in SQL (`depreciatedPurchasePriceSql` in
 * `ReportRepository`) so a 100k-item total can be summed by the database rather than folded in
 * JavaScript. Sharing the constant is what stops the two statements of the same formula drifting
 * by a rounding of the month length.
 */
export const DEPRECIATION_MS_PER_MONTH = (365.25 / 12) * 86_400_000;

/**
 * Compute the current book value of an item under straight-line depreciation.
 *
 * Returns `null` when no `purchase_price` is set (the widget is hidden).
 * When `depreciation_months` is NULL the asset does not depreciate — the book value
 * stays equal to `purchase_price` indefinitely.
 * When `acquired_at` is NULL and depreciation is set, depreciation starts from `now`
 * (i.e. the asset is treated as "just acquired" and the residual equals
 * `purchase_price`).
 *
 * The result is **floored at 0** — an asset cannot have a negative book value.
 *
 * Straight-line formula: `residual = purchasePrice × (1 − elapsedMonths / totalMonths)`
 * with `totalMonths = depreciationMonths`.
 */
export function currentValue(item: AssetLifecycleItem, now: number): number | null {
  if (item.purchasePrice == null) return null;

  const price = item.purchasePrice;

  // No depreciation term → flat book value.
  if (item.depreciationMonths == null) return price;

  // If no acquisition date treat the item as newly acquired: elapsed months = 0,
  // so the residual equals the purchase price.
  if (item.acquiredAt == null) return price;

  const acquiredMs = Date.parse(item.acquiredAt);
  if (!Number.isFinite(acquiredMs)) return price;

  const elapsedMonths = (now - acquiredMs) / DEPRECIATION_MS_PER_MONTH;

  const totalMonths = item.depreciationMonths;
  const proportion = Math.min(1, Math.max(0, elapsedMonths / totalMonths));
  const residual = price * (1 - proportion);

  return Math.max(0, residual);
}
