/**
 * Category-template default maintenance schedule (backlog T2a).
 *
 * A category may carry a default maintenance schedule — a {@link MaintenanceBasis} plus its
 * matching interval — set in the category manager. Unlike the T1/T2 soft-prefills (which
 * pre-fill a create-form field the user can still override), this is *applied*: when an item
 * is created in such a category, the item create paths (`create` / `createMany` /
 * `createSerialised`) append a `maintenance_schedules` INSERT for the new item **in the same
 * atomic transaction** as the item itself, so a bulk/import create honours it too and the
 * schedule can never be orphaned by a half-committed create.
 *
 * The application is deliberately strict: it fires only for a *complete* default — a basis
 * AND its matching interval both set. A category with no basis, or a basis whose interval was
 * left blank, yields nothing (a leave-it-off category gets no schedule). The written row is
 * indistinguishable from one added by hand: it mirrors the column shape
 * `MaintenanceRepository.create` writes for a plain schedule (no usage unit, no checkout-hour
 * accrual, item-level scope), so every downstream read/edit treats it identically.
 */
import type { SqlStatement } from '../../rpc/driver';
import type { MaintenanceBasis } from '../constants';

/**
 * Display name given to a schedule materialised from a category default. A seeded system
 * string (like the "Unassigned" location name), not a translated UI string — it is stored
 * data the user can rename per item once the schedule exists.
 */
export const DEFAULT_CATEGORY_MAINTENANCE_NAME = 'Scheduled maintenance';

/** The category columns that describe a default maintenance schedule (raw row shape). */
export interface CategoryMaintenanceDefault {
  readonly default_maintenance_basis: MaintenanceBasis | null;
  readonly default_maintenance_interval_days: number | null;
  readonly default_maintenance_interval_usage: number | null;
}

/**
 * Build the `maintenance_schedules` INSERT that applies a category's default schedule to a
 * freshly-created item, or `null` when the category carries no *complete* default. The row id
 * is generated here so the caller can fold the INSERT into the item's own create transaction.
 */
export function buildCategoryMaintenanceInsert(
  itemId: string,
  category: CategoryMaintenanceDefault | null | undefined,
): SqlStatement | null {
  if (!category) return null;
  const basis = category.default_maintenance_basis;
  if (basis === 'TIME' && category.default_maintenance_interval_days != null) {
    return maintenanceInsert(itemId, 'TIME', category.default_maintenance_interval_days, null);
  }
  if (basis === 'USAGE' && category.default_maintenance_interval_usage != null) {
    return maintenanceInsert(itemId, 'USAGE', null, category.default_maintenance_interval_usage);
  }
  return null;
}

function maintenanceInsert(
  itemId: string,
  basis: MaintenanceBasis,
  intervalDays: number | null,
  intervalUsage: number | null,
): SqlStatement {
  return {
    sql: `INSERT INTO maintenance_schedules
            (id, item_id, name, basis, interval_days, interval_usage,
             usage_unit, accrue_checkout_hours, location_id, note)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL);`,
    params: [
      crypto.randomUUID(),
      itemId,
      DEFAULT_CATEGORY_MAINTENANCE_NAME,
      basis,
      intervalDays,
      intervalUsage,
    ],
  };
}
