/**
 * Pure field validators/normalisers shared by the item create and update paths.
 * Blank free-text collapses to NULL; numeric fields are range-checked here so the
 * repository contract rejects bad input the same way regardless of the entry point.
 */
import { canonicaliseBarcode } from '@/features/scanner/gtin';
import { toStoredMoney } from '@/lib/money';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { DbError } from '../../errors';
import { assertTextLimit } from '../text-limits';

/**
 * Trim a free-text field, collapsing blank/whitespace-only input to NULL, and refuse one that
 * is over its length ceiling.
 *
 * The ceiling defaults to {@link TEXT_LIMITS.line}, which is what almost every column reached
 * through here is: one line of typed text. Pass a tier explicitly for a column that is not —
 * {@link TEXT_LIMITS.note} for prose, {@link TEXT_LIMITS.url} for a link — and pass `subject` so
 * the refusal names the field rather than the shape.
 */
export function normaliseText(
  value: string | null | undefined,
  limit: number = TEXT_LIMITS.line,
  subject = 'That entry',
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  assertTextLimit(trimmed, limit, subject);
  return trimmed;
}

/**
 * Normalise a barcode for storage: {@link normaliseText}, then the UPC-E canonicalisation
 * (issue #508).
 *
 * A UPC-E is a compressed UPC-A, so the eight digits printed on a small pack and the twelve a
 * UPC-A scan of the same article yields are the *same* barcode. Storing whichever form happened
 * to arrive would make them two, and only one of them would ever be found again by scanning.
 * Normalising here rather than at each entry point means a typed code, a scan and an imported
 * spreadsheet column all land on the same value. Every other code — a Code 128 part label, a
 * shelf code, an EAN-8 that is not also a valid UPC-E — is stored exactly as given.
 *
 * Pass `current` on an update: a value that matches what is already stored is left untouched.
 * Re-saving an item must not migrate a barcode nobody edited — that would rewrite a record on an
 * unrelated change and log it in the Activity Log as a barcode the user never touched.
 */
export function normaliseBarcode(
  value: string | null | undefined,
  current: string | null = null,
): string | null {
  const text = normaliseText(value, TEXT_LIMITS.line, 'A barcode');
  if (text === null || text === current) return text;
  return canonicaliseBarcode(text);
}

/**
 * Validate an optional unit cost: null clears it; otherwise it must be ≥ 0. The returned value is
 * in integer **micro-units** — the on-disk money scale (issue #286) — so both the create and
 * update write paths persist the same representation.
 */
export function normaliseUnitCost(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Unit cost must be a non-negative number.');
  }
  return toStoredMoney(value);
}

/**
 * Validate a gauge's optional cost per unit of measure (issue #683): null clears it, leaving the
 * gauge unpriced; otherwise it must be ≥ 0. Returned in integer **micro-units** like every other
 * money value crossing the write boundary (issue #286).
 *
 * Separate from {@link normaliseUnitCost} only for its message — the two price different things
 * (one countable unit versus one unit of measure), so naming the wrong one in the error would
 * send a user to the wrong control.
 */
export function normaliseCostPerUnitOfMeasure(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Cost per unit of measure must be a non-negative number.');
  }
  return toStoredMoney(value);
}

/**
 * Validate an optional integer reorder threshold/quantity (Phase 59): null clears it
 * (fall back to the global default); otherwise it must be a non-negative integer.
 */
export function normaliseReorderInt(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'A reorder threshold must be a non-negative number.');
  }
  return Math.trunc(value);
}

/**
 * Validate an optional reorder gauge percentage (Phase 59): null clears it; otherwise it
 * must be within 0–100 (a percentage-remaining floor).
 */
export function normaliseReorderPercent(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new DbError('SQLITE_CONSTRAINT', 'A reorder percentage must be between 0 and 100.');
  }
  return value;
}

/** Validate an optional expiry instant: null clears it; otherwise a finite UNIX-ms. */
export function normaliseExpiry(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) {
    throw new DbError('SQLITE_CONSTRAINT', 'Expiry date must be a valid timestamp.');
  }
  return Math.trunc(value);
}

/**
 * Validate an optional ISO calendar-date string (Phase 66 asset lifecycle, v24).
 * Null/empty clears the field, and the stored form is the canonical `YYYY-MM-DD` slice
 * (no time component) matching `<input type="date">` — the format every caller already
 * supplies.
 *
 * The calendar fields are read straight out of the string and range-checked in **UTC**;
 * the field must not go through `Date.parse` → `toISOString()`. That round-trip silently
 * shifted the day for any value `Date.parse` reads as *local* time (`2026/07/20`, an
 * RFC-2822-ish string): local midnight re-serialised to UTC lands on the previous day in
 * every UTC-positive zone, and `acquired_at` / `warranty_expires_at` are read back as UTC
 * midnight, so the stored day no longer matched the day the user meant (#327). Anything
 * that is not a bare `YYYY-MM-DD` is rejected rather than coerced, so an import path can
 * never inherit that silent shift.
 */
export function normaliseIsoDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // Require the calendar fields to round-trip through Date.UTC unchanged, so overflow
    // (e.g. 2026-02-30 → 2026-03-02) and impossible months/days are rejected, not coerced.
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return trimmed;
    }
  }
  throw new DbError('SQLITE_CONSTRAINT', 'Date must be a valid ISO calendar date (YYYY-MM-DD).');
}

/**
 * Validate an optional purchase price (Phase 66 asset lifecycle, v24): null clears
 * it; otherwise it must be a finite, non-negative number. Returned in integer micro-units
 * (issue #286).
 */
export function normalisePurchasePrice(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Purchase price must be a non-negative number.');
  }
  return toStoredMoney(value);
}

/**
 * Validate an optional depreciation-months value (Phase 66 asset lifecycle, v24):
 * null clears it (no depreciation); otherwise it must be a positive **whole** number of
 * months, mirroring the `items.depreciation_months > 0` CHECK — asserted in
 * `normalise-db-check.test.ts` alongside the other numeric guards (issue #254).
 *
 * The truncation happens before the range check, not after: a fraction under one month
 * (`0.5`) is positive as typed but truncates to `0`, which the column refuses. Checking
 * first passed that value out of here as a `0` and turned a field-level refusal into a
 * constraint abort in the middle of the write (issue #254).
 */
export function normaliseDepreciationMonths(value: number | null | undefined): number | null {
  if (value == null) return null;
  const months = Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(months) || months <= 0) {
    throw new DbError(
      'SQLITE_CONSTRAINT',
      'Depreciation months must be a whole number of months, at least 1.',
    );
  }
  return months;
}

/**
 * Validate an optional intrinsic weight (issue #25): null clears it; otherwise it must be a
 * finite, non-negative number (canonical **grams**). Mirrors the `items.weight` DB CHECK; see
 * `normalise-db-check.test.ts`, which asserts the two agree rather than assuming it (issue #254).
 */
export function normaliseWeight(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Weight must be a non-negative number.');
  }
  return value;
}

/**
 * Validate an optional intrinsic dimension (issue #30): null clears it; otherwise it must be a
 * finite, non-negative number (canonical **millimetres**). Shared by width / height / depth,
 * mirroring their identical `items.width/height/depth` DB CHECKs — asserted, not assumed, in
 * `normalise-db-check.test.ts` (issue #254). `label` names the offending dimension in the error
 * message.
 */
export function normaliseDimension(
  value: number | null | undefined,
  label: 'Width' | 'Height' | 'Depth',
): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', `${label} must be a non-negative number.`);
  }
  return value;
}

/**
 * Validate an optional manual current / market value (feature-gap G9, v4): null clears it
 * (valuation reverts to the depreciated replacement cost); otherwise it must be a finite,
 * non-negative number. Mirrors {@link normalisePurchasePrice} + the `items.current_value >= 0`
 * DB CHECK — a parity that `normalise-db-check.test.ts` holds up by driving the same probe values
 * through this guard and the real constraint (issue #254). Returned in integer micro-units
 * (issue #286).
 */
export function normaliseCurrentValue(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Current value must be a non-negative number.');
  }
  return toStoredMoney(value);
}
