/**
 * Pure field validators/normalisers shared by the item create and update paths.
 * Blank free-text collapses to NULL; numeric fields are range-checked here so the
 * repository contract rejects bad input the same way regardless of the entry point.
 */
import { DbError } from '../../errors';

/** Trim a free-text field, collapsing blank/whitespace-only input to NULL. */
export function normaliseText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate an optional unit cost: null clears it; otherwise it must be ≥ 0. */
export function normaliseUnitCost(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Unit cost must be a non-negative number.');
  }
  return value;
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
 * Null/empty clears the field. A non-parseable value is rejected so the DB never
 * stores a string that `Date.parse` would return `NaN` on. Normalises to the
 * `YYYY-MM-DD` slice only — no time component — matching `<input type="date">` format.
 */
export function normaliseIsoDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new DbError('SQLITE_CONSTRAINT', 'Date must be a valid ISO calendar date (YYYY-MM-DD).');
  }
  // Re-serialise to the canonical YYYY-MM-DD slice so callers don't rely on the
  // exact string the user typed (the date-input value is always this format already).
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate an optional purchase price (Phase 66 asset lifecycle, v24): null clears
 * it; otherwise it must be a finite, non-negative number.
 */
export function normalisePurchasePrice(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Purchase price must be a non-negative number.');
  }
  return value;
}

/**
 * Validate an optional depreciation-months value (Phase 66 asset lifecycle, v24):
 * null clears it (no depreciation); otherwise it must be a positive integer.
 */
export function normaliseDepreciationMonths(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Depreciation months must be a positive number.');
  }
  return Math.trunc(value);
}
