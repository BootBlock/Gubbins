/**
 * Tool maintenance-schedule row + DTO types (spec §4.3, Phase 9).
 */
import type { MaintenanceBasis } from '../constants';

export interface MaintenanceScheduleRow {
  readonly id: string;
  readonly item_id: string;
  readonly name: string;
  readonly basis: MaintenanceBasis;
  readonly interval_days: number | null;
  readonly interval_usage: number | null;
  readonly usage_unit: string | null;
  readonly usage_since_service: number;
  readonly accrue_checkout_hours: number;
  /** Placement this schedule is scoped to (Phase 30); NULL = the whole item. */
  readonly location_id: string | null;
  readonly last_performed_at: number | null;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** Derived in SELECTs: checkout-hours accrued since service (accrue mode); else 0. */
  readonly auto_usage_hours?: number;
  /** Derived in SELECTs (LEFT JOIN locations): the scope location's name; null if item-level. */
  readonly location_name?: string | null;
}

export interface MaintenanceSchedule {
  readonly id: string;
  readonly itemId: string;
  readonly name: string;
  readonly basis: MaintenanceBasis;
  /** Calendar interval in days (TIME basis); null for USAGE. */
  readonly intervalDays: number | null;
  /** Usage units between services (USAGE basis); null for TIME. */
  readonly intervalUsage: number | null;
  /** Label for the usage counter, e.g. "hours" (USAGE basis). */
  readonly usageUnit: string | null;
  /** Manually-logged usage accrued since the last service (USAGE basis, manual mode). */
  readonly usageSinceService: number;
  /**
   * Whether this USAGE schedule derives its usage from real checkout-hours (§4.3,
   * Phase 22) rather than the manual counter. When true, {@link autoUsageHours} is the
   * live figure and `usageSinceService` is ignored.
   */
  readonly accrueCheckoutHours: boolean;
  /**
   * Checkout-hours accrued from loans since the last service (USAGE + accrue mode) — a
   * derived projection over the `checkouts` ledger, computed at read time; 0 otherwise.
   * When the schedule is location-scoped, only loans drawn from that placement count.
   */
  readonly autoUsageHours: number;
  /**
   * Placement this schedule is scoped to (Phase 30, §4.3); null = the whole item. A
   * location-scoped USAGE/accrue schedule attributes only that placement's loan-hours.
   */
  readonly locationId: string | null;
  /** The scope location's display name (joined on read); null when item-level. */
  readonly locationName: string | null;
  /** Last service instant (UNIX-ms); null = never serviced. */
  readonly lastPerformedAt: number | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A schedule joined with its item's display name, for the dashboard "due" widget. */
export interface MaintenanceScheduleWithItem extends MaintenanceSchedule {
  readonly itemName: string;
}

export interface CreateMaintenanceInput {
  readonly itemId: string;
  readonly name: string;
  readonly basis: MaintenanceBasis;
  /** Required for a TIME schedule (positive days). */
  readonly intervalDays?: number | null;
  /** Required for a USAGE schedule (positive usage units). */
  readonly intervalUsage?: number | null;
  readonly usageUnit?: string | null;
  /** USAGE only: derive usage from real checkout-hours instead of manual logging (§4.3). */
  readonly accrueCheckoutHours?: boolean;
  /**
   * Scope the schedule to a specific placement (Phase 30, §4.3); omit/null = the whole
   * item. A USAGE/accrue schedule then accrues only loans drawn from that location.
   */
  readonly locationId?: string | null;
  readonly note?: string | null;
}
