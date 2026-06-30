/**
 * Asset lifecycle pure logic (Phase 66, spec §4 asset facet).
 *
 * Straight-line depreciation and warranty-status derivation from the four nullable
 * `items` columns added in v24: `acquired_at`, `warranty_expires_at`,
 * `purchase_price`, `depreciation_months`. All functions are **pure** — they take
 * an item-shaped slice and a `now` instant; no DB access, no side effects — so they
 * are exhaustively unit-testable in isolation (same "logic out of glue" seam as
 * `reorder-policy.ts`, `cycle-count.ts`).
 */

/** Days before warranty expiry at which status changes from `active` to `expiring-soon`. */
export const WARRANTY_EXPIRING_SOON_DAYS = 30;

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
 * - `'expired'`        — today is past the warranty expiry date.
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

  if (now > expiryMs) return 'expired';

  const msPerDay = 86_400_000;
  const daysRemaining = (expiryMs - now) / msPerDay;
  if (daysRemaining <= WARRANTY_EXPIRING_SOON_DAYS) return 'expiring-soon';

  return 'active';
}

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

  // Elapsed months as a continuous fraction (365.25 days / 12 ≈ 30.4375 days/month).
  const MS_PER_MONTH = (365.25 / 12) * 86_400_000;
  const elapsedMonths = (now - acquiredMs) / MS_PER_MONTH;

  const totalMonths = item.depreciationMonths;
  const proportion = Math.min(1, Math.max(0, elapsedMonths / totalMonths));
  const residual = price * (1 - proportion);

  return Math.max(0, residual);
}
