/**
 * Alert-centre pure seam (Phase 68, spec §3 alert centre).
 *
 * Folds four existing data sources — low stock, perishable expiry, maintenance-due
 * and warranty-due — into a single sorted, typed `Alert[]`. All functions are pure
 * (no DB access, no side-effects, `now` injected) so they are exhaustively
 * unit-testable in isolation, following the same "logic out of glue" seam as
 * `reorder-policy.ts`, `expiry.ts` and `asset-lifecycle.ts`.
 *
 * **Warranty gate**: the warranty lane is conditional on Phase-66 fields. An item
 * without `warrantyExpiresAt` never produces a warranty alert — the function returns
 * nothing for it, matching the `'none'` case of `warrantyStatus`.
 *
 * **Dismissal**: dismissed alert ids are stored device-locally (no DB migration).
 * A re-triggered alert with a *new* id reappears automatically.
 *
 * **Web push**: not implemented here. This is a backend-less PWA; web push requires a
 * server-side push subscription service. Deferred — see docs/dev/deferred-features.md.
 */

import {
  warrantyStatus,
  WARRANTY_EXPIRING_SOON_DAYS,
  type AssetLifecycleItem,
} from '@/features/inventory/asset-lifecycle';
import { expiryStatus } from '@/features/lifecycle/expiry';
import { MS_PER_DAY } from '@/db/repositories/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four alert categories produced by the alert centre. */
export type AlertKind = 'low-stock' | 'expiry' | 'maintenance-due' | 'warranty-due';

/**
 * How urgent the alert is:
 * - `critical` — already overdue / expired / out of stock.
 * - `warning`  — approaching a threshold (expiring soon / low stock).
 * - `info`     — general informational notice (currently unused but reserved).
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Deep-link target so an alert can navigate the user to the relevant resource. */
export interface AlertTarget {
  /** TanStack Router path, e.g. `'/inventory'`. */
  readonly route: string;
  /** Optional item id for filtering / pre-selecting on the destination screen. */
  readonly itemId?: string;
}

/**
 * A single proactive alert surfaced in the alert centre.
 *
 * The `id` is deterministic from the source entity so that the same underlying
 * condition always produces the same id — only when the condition is resolved or the
 * expiry date changes will the id change and the alert reappear after dismissal.
 */
export interface Alert {
  readonly id: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly title: string;
  /** Supplementary copy (may contain the quantity, expiry date, etc.). */
  readonly detail: string;
  /** ISO-8601 date/time string used for "soonest first" ordering; null = N/A. */
  readonly dueAt: string | null;
  readonly target: AlertTarget;
}

// ---------------------------------------------------------------------------
// Source shapes (minimal slices — callers pass their own repository DTOs)
// ---------------------------------------------------------------------------

/** Minimum item fields required for a low-stock alert. */
export interface LowStockSource {
  readonly id: string;
  readonly name: string;
}

/** Minimum item fields required for an expiry alert. */
export interface ExpirySource {
  readonly id: string;
  readonly name: string;
  /** UNIX-ms expiry instant; null = no expiry set (item is skipped). */
  readonly expiryDate: number | null;
}

/** Minimum maintenance schedule fields required for a maintenance-due alert. */
export interface MaintenanceDueSource {
  readonly id: string;
  readonly name: string;
  readonly itemId: string;
  readonly itemName: string;
  /**
   * When the TIME schedule fell/falls due (UNIX-ms) — used for ordering.
   * For USAGE schedules pass `null` (the ordering uses `dueAt: null`).
   */
  readonly dueAtMs: number | null;
}

/** Minimum item fields required for a warranty alert (Phase-66 gated). */
export interface WarrantySource extends AssetLifecycleItem {
  readonly id: string;
  readonly name: string;
}

/** The four source arrays passed to `buildAlerts`. */
export interface AlertSources {
  readonly lowStock: readonly LowStockSource[];
  readonly expiring: readonly ExpirySource[];
  readonly maintenanceDue: readonly MaintenanceDueSource[];
  readonly warrantyItems: readonly WarrantySource[];
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/** Numeric weight used for severity ordering (lower = shown first). */
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// Lane builders (pure; each returns zero or one Alert per source item)
// ---------------------------------------------------------------------------

function buildLowStockAlerts(sources: readonly LowStockSource[]): Alert[] {
  return sources.map((item) => ({
    id: `low-stock:${item.id}`,
    kind: 'low-stock',
    severity: 'warning' as AlertSeverity,
    title: `Low stock — ${item.name}`,
    detail: 'This item is at or below its reorder point.',
    dueAt: null,
    target: { route: '/inventory', itemId: item.id },
  }));
}

function buildExpiryAlerts(sources: readonly ExpirySource[], now: number): Alert[] {
  const alerts: Alert[] = [];
  for (const item of sources) {
    const status = expiryStatus(item.expiryDate, now);
    if (status === 'NONE' || status === 'FRESH') continue;

    const severity: AlertSeverity = status === 'EXPIRED' ? 'critical' : 'warning';
    const dueAt =
      item.expiryDate != null ? new Date(item.expiryDate).toISOString() : null;
    const detail =
      status === 'EXPIRED'
        ? `Expiry date has passed${dueAt ? ` (${dueAt.slice(0, 10)})` : ''}.`
        : `Expires soon${dueAt ? ` on ${dueAt.slice(0, 10)}` : ''}.`;

    alerts.push({
      id: `expiry:${item.id}`,
      kind: 'expiry',
      severity,
      title: `${status === 'EXPIRED' ? 'Expired' : 'Expiring soon'} — ${item.name}`,
      detail,
      dueAt,
      target: { route: '/inventory', itemId: item.id },
    });
  }
  return alerts;
}

function buildMaintenanceDueAlerts(
  sources: readonly MaintenanceDueSource[],
  now: number,
): Alert[] {
  return sources.map((schedule) => {
    const dueAt =
      schedule.dueAtMs != null ? new Date(schedule.dueAtMs).toISOString() : null;
    const overdue = schedule.dueAtMs != null && schedule.dueAtMs < now;
    return {
      id: `maintenance-due:${schedule.id}`,
      kind: 'maintenance-due',
      severity: (overdue ? 'critical' : 'warning') as AlertSeverity,
      title: `Maintenance due — ${schedule.itemName}`,
      detail: `Schedule: "${schedule.name}"${dueAt ? `. Due ${dueAt.slice(0, 10)}.` : '.'}`,
      dueAt,
      target: { route: '/inventory', itemId: schedule.itemId },
    };
  });
}

function buildWarrantyAlerts(
  sources: readonly WarrantySource[],
  now: number,
): Alert[] {
  const alerts: Alert[] = [];
  for (const item of sources) {
    // Gate: items without warrantyExpiresAt produce no warranty alert (P66 field).
    if (item.warrantyExpiresAt == null) continue;

    const status = warrantyStatus(item, now);
    if (status === 'none' || status === 'active') continue;

    const dueAtMs = Date.parse(item.warrantyExpiresAt);
    const dueAt = Number.isFinite(dueAtMs)
      ? new Date(dueAtMs).toISOString()
      : null;

    const severity: AlertSeverity = status === 'expired' ? 'critical' : 'warning';
    const detail =
      status === 'expired'
        ? `Warranty expired${dueAt ? ` on ${dueAt.slice(0, 10)}` : ''}.`
        : `Warranty expires soon${dueAt ? ` on ${dueAt.slice(0, 10)}` : ''} (within ${WARRANTY_EXPIRING_SOON_DAYS} days).`;

    alerts.push({
      id: `warranty-due:${item.id}:${item.warrantyExpiresAt}`,
      kind: 'warranty-due',
      severity,
      title: `${status === 'expired' ? 'Warranty expired' : 'Warranty expiring soon'} — ${item.name}`,
      detail,
      dueAt,
      target: { route: '/inventory', itemId: item.id },
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// buildAlerts — the primary export
// ---------------------------------------------------------------------------

/**
 * Fold the four alert sources into a single sorted `Alert[]`.
 *
 * Sorting rules (stable):
 * 1. Severity — critical before warning before info.
 * 2. `dueAt` — soonest ISO string first (nulls sort last).
 * 3. `id` — deterministic tie-break.
 *
 * @param sources - The four pre-fetched source arrays.
 * @param now     - Current wall-clock instant (UNIX-ms). Injected for testability.
 */
export function buildAlerts(sources: AlertSources, now: number): Alert[] {
  const all: Alert[] = [
    ...buildLowStockAlerts(sources.lowStock),
    ...buildExpiryAlerts(sources.expiring, now),
    ...buildMaintenanceDueAlerts(sources.maintenanceDue, now),
    ...buildWarrantyAlerts(sources.warrantyItems, now),
  ];

  return all.slice().sort((a, b) => {
    // 1. Severity rank (lower = more urgent = first).
    const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sr !== 0) return sr;

    // 2. dueAt: soonest first; nulls last.
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt == null) return 1;
      if (b.dueAt == null) return -1;
      return a.dueAt < b.dueAt ? -1 : 1;
    }

    // 3. Deterministic tie-break by id.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Dismissal helpers
// ---------------------------------------------------------------------------

/**
 * Filter out alerts whose ids are in the dismissed set.
 *
 * Dismissed ids are stored device-locally (Zustand persist) — see
 * `useDismissedAlertsStore.ts`. A re-triggered alert with a new id reappears.
 */
export function applyDismissals(
  alerts: readonly Alert[],
  dismissedIds: ReadonlySet<string>,
): Alert[] {
  return alerts.filter((a) => !dismissedIds.has(a.id));
}

/**
 * Group a flat alert list by kind. Useful for rendering per-category sections.
 * Preserves the original within-group ordering.
 */
export function groupByKind(alerts: readonly Alert[]): Map<AlertKind, Alert[]> {
  const map = new Map<AlertKind, Alert[]>();
  for (const alert of alerts) {
    const existing = map.get(alert.kind);
    if (existing) {
      existing.push(alert);
    } else {
      map.set(alert.kind, [alert]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Re-export the maintenance `dueAtMs` helper so callers can derive it without
// importing from the repository layer directly.
// ---------------------------------------------------------------------------

/** Derive the TIME schedule due instant (UNIX-ms) from the raw row fields.
 *  Returns null for USAGE schedules (no calendar due date). */
export function maintenanceDueAtMs(
  basis: 'TIME' | 'USAGE',
  lastPerformedAt: number | null,
  createdAt: number,
  intervalDays: number | null,
): number | null {
  if (basis !== 'TIME' || intervalDays == null) return null;
  const anchor = lastPerformedAt ?? createdAt;
  return anchor + intervalDays * MS_PER_DAY;
}
