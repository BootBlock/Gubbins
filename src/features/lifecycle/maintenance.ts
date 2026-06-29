/**
 * Tool maintenance scheduling maths (spec §4.3 Tool Maintenance & Calibration),
 * kept pure and isolated. A schedule fires on elapsed `TIME` (days since the last
 * service, or creation if never serviced) or on accrued `USAGE` (a manually-logged
 * counter reaching the interval). "Due-ness" is *computed*, never stored. Shared by
 * the repository (classifying schedules on read), the dashboard widget and toasts.
 */
import { MS_PER_DAY, MS_PER_HOUR, type MaintenanceBasis } from '@/db/repositories/constants';

export interface MaintenanceScheduleState {
  readonly basis: MaintenanceBasis;
  /** Calendar interval in days (TIME basis). */
  readonly intervalDays: number | null;
  /** Usage units between services, e.g. 100 hours (USAGE basis). */
  readonly intervalUsage: number | null;
  /** Manually-logged usage accrued since the last service (USAGE basis, manual mode). */
  readonly usageSinceService: number;
  /**
   * Whether this USAGE schedule derives its usage from real checkout-hours (§4.3,
   * Phase 22) instead of the manual counter. When true, {@link effectiveUsage} reads
   * {@link autoUsage} (a derived projection over the `checkouts` ledger) and ignores
   * {@link usageSinceService}.
   */
  readonly accrueCheckoutHours?: boolean;
  /**
   * Usage-hours accrued from loans since the last service (USAGE + accrue mode). A
   * *derived* figure the repository computes from the `checkouts` ledger; the pure
   * maths just reads it. Defaults to 0 (no loans / manual mode).
   */
  readonly autoUsage?: number;
  /** When the schedule was last serviced (UNIX ms); null = never. */
  readonly lastPerformedAt: number | null;
  /** When the schedule was created (UNIX ms) — the TIME anchor when never serviced. */
  readonly createdAt: number;
}

/**
 * The usage figure a USAGE schedule is measured against: the derived checkout-hours
 * when it auto-accrues (Phase 22), otherwise the manually-logged counter (Phase 9).
 */
export function effectiveUsage(state: MaintenanceScheduleState): number {
  return state.accrueCheckoutHours ? (state.autoUsage ?? 0) : state.usageSinceService;
}

export interface MaintenanceStatus {
  /** True once the schedule is due (or overdue). */
  readonly due: boolean;
  /** TIME basis: the instant it falls due (UNIX ms). */
  readonly dueAt: number | null;
  /** TIME basis: whole days remaining (negative once overdue). */
  readonly remainingDays: number | null;
  /** USAGE basis: usage units remaining before due (negative once overdue). */
  readonly remainingUsage: number | null;
}

/**
 * Classify a maintenance schedule against the current instant. Pure: callers pass
 * `now` (the repository injects `Date.now()`), so tests are deterministic.
 */
export function maintenanceStatus(
  state: MaintenanceScheduleState,
  now: number,
): MaintenanceStatus {
  if (state.basis === 'TIME') {
    const anchor = state.lastPerformedAt ?? state.createdAt;
    const dueAt = anchor + (state.intervalDays ?? 0) * MS_PER_DAY;
    return {
      due: now >= dueAt,
      dueAt,
      remainingDays: Math.floor((dueAt - now) / MS_PER_DAY),
      remainingUsage: null,
    };
  }
  // USAGE basis — measured against the effective usage (derived checkout-hours when
  // the schedule auto-accrues, else the manual counter).
  const remainingUsage = (state.intervalUsage ?? 0) - effectiveUsage(state);
  return {
    due: remainingUsage <= 0,
    dueAt: null,
    remainingDays: null,
    remainingUsage,
  };
}

/** A loan window from the `checkouts` ledger, as far as usage telemetry cares (§4.3). */
export interface CheckoutWindow {
  /** When the item was checked out (UNIX ms). */
  readonly checkedOutAt: number;
  /** When it was returned (UNIX ms); null = still out (accruing up to `now`). */
  readonly returnedAt: number | null;
  /**
   * The placement the loan was drawn from (`checkouts.source_location_id`, Phase 26);
   * null when no specific source was recorded. Only consulted when {@link accruedCheckoutHours}
   * is scoped to a location (Phase 30).
   */
  readonly sourceLocationId?: string | null;
}

/**
 * Hours a single loan has accrued by `now`: the elapsed span from checkout to return
 * (or to `now` while still out), in hours. Clamped at 0 so a clock-skewed window
 * (returned before checked out) never contributes negative usage.
 */
export function checkoutHours(window: CheckoutWindow, now: number): number {
  const end = window.returnedAt ?? now;
  return Math.max(0, end - window.checkedOutAt) / MS_PER_HOUR;
}

/**
 * Total checkout-hours accrued toward a schedule since its service anchor (Phase 22):
 * the sum of {@link checkoutHours} over every loan *begun* at or after `anchor`
 * (`last_performed_at ?? created_at`). Counting by start instant keeps attribution
 * unambiguous — a loan begun since the last service belongs wholly to the new cycle —
 * and `logPerformed` resets the figure for free by advancing the anchor. Pure: callers
 * inject `now`, so a still-open loan's contribution is deterministic in tests.
 *
 * When `scopeLocationId` is given (a location-scoped schedule, Phase 30), only loans drawn
 * *from that placement* (`sourceLocationId`) count — each placement's wear accrues against
 * its own service clock. Omit it (the item-level default) to count every loan.
 */
export function accruedCheckoutHours(
  windows: readonly CheckoutWindow[],
  anchor: number,
  now: number,
  scopeLocationId?: string | null,
): number {
  return windows
    .filter((w) => w.checkedOutAt >= anchor)
    .filter((w) => scopeLocationId == null || w.sourceLocationId === scopeLocationId)
    .reduce((total, w) => total + checkoutHours(w, now), 0);
}

/**
 * Compose the standard "maintenance performed" ledger note (§4.3 → Activity Log).
 * e.g. "Lubricate rails performed (reset 112h of usage)" or "… (was 4 days overdue)".
 */
export function maintenancePerformedNote(
  name: string,
  state: MaintenanceScheduleState,
  now: number,
): string {
  if (state.basis === 'USAGE') {
    if (state.accrueCheckoutHours) {
      const hours = Math.round((state.autoUsage ?? 0) * 10) / 10;
      return `${name} performed (reset ${hours}h of loan usage).`;
    }
    return `${name} performed (reset ${state.usageSinceService} of usage).`;
  }
  const status = maintenanceStatus(state, now);
  const days = status.remainingDays ?? 0;
  const when =
    days < 0 ? `${-days} day(s) overdue` : days === 0 ? 'on the day it was due' : `${days} day(s) early`;
  return `${name} performed (${when}).`;
}
