/**
 * Tool maintenance scheduling maths (spec §4.3 Tool Maintenance & Calibration),
 * kept pure and isolated. A schedule fires on elapsed `TIME` (days since the last
 * service, or creation if never serviced) or on accrued `USAGE` (a manually-logged
 * counter reaching the interval). "Due-ness" is *computed*, never stored. Shared by
 * the repository (classifying schedules on read), the dashboard widget and toasts.
 */
import { MS_PER_DAY, type MaintenanceBasis } from '@/db/repositories/constants';

export interface MaintenanceScheduleState {
  readonly basis: MaintenanceBasis;
  /** Calendar interval in days (TIME basis). */
  readonly intervalDays: number | null;
  /** Usage units between services, e.g. 100 hours (USAGE basis). */
  readonly intervalUsage: number | null;
  /** Usage accrued since the last service (USAGE basis). */
  readonly usageSinceService: number;
  /** When the schedule was last serviced (UNIX ms); null = never. */
  readonly lastPerformedAt: number | null;
  /** When the schedule was created (UNIX ms) — the TIME anchor when never serviced. */
  readonly createdAt: number;
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
  // USAGE basis.
  const remainingUsage = (state.intervalUsage ?? 0) - state.usageSinceService;
  return {
    due: remainingUsage <= 0,
    dueAt: null,
    remainingDays: null,
    remainingUsage,
  };
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
    const unitSuffix = '';
    return `${name} performed (reset ${state.usageSinceService}${unitSuffix} of usage).`;
  }
  const status = maintenanceStatus(state, now);
  const days = status.remainingDays ?? 0;
  const when =
    days < 0 ? `${-days} day(s) overdue` : days === 0 ? 'on the day it was due' : `${days} day(s) early`;
  return `${name} performed (${when}).`;
}
