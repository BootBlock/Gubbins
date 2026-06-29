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

/** Validate an optional expiry instant: null clears it; otherwise a finite UNIX-ms. */
export function normaliseExpiry(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) {
    throw new DbError('SQLITE_CONSTRAINT', 'Expiry date must be a valid timestamp.');
  }
  return Math.trunc(value);
}
