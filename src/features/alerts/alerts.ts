/**
 * Alert-centre pure seam (Phase 68, spec §3 alert centre).
 *
 * Folds five existing data sources — low stock, perishable expiry, maintenance-due,
 * warranty-due and opted-in custom-field due dates (W1a) — into a single sorted, typed
 * `Alert[]`. All functions are pure
 * (no DB access, no side-effects, `now` and the date formatters injected) so they are
 * exhaustively unit-testable in isolation, following the same "logic out of glue" seam as
 * `reorder-policy.ts`, `expiry.ts` and `asset-lifecycle.ts`.
 *
 * **Warranty gate**: the warranty lane is conditional on Phase-66 fields. An item
 * without `warrantyExpiresAt` never produces a warranty alert — the function returns
 * nothing for it, matching the `'none'` case of `warrantyStatus`.
 *
 * **Dismissal**: dismissed alert ids are stored device-locally (no DB migration).
 * A re-triggered alert with a *new* id reappears automatically. A dismissal can also
 * carry a deadline — a snooze — after which the alert returns on its own.
 *
 * **Custom-field gate**: the `field-due` lane only ever sees rows whose *definition* opted in
 * (`field_defs.due_lead_days`), so an ordinary `DATE` field — "Date acquired" — raises nothing.
 * The repository read applies that filter; this seam grades what comes back.
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
import { inventorySearchFor, type InventorySearchParams } from '@/features/inventory/view-params';
import { fieldDueStatus } from '@/features/lifecycle/field-due';
import { addCalendarDays } from '@/lib/calendar-days';
import { plural } from '@/lib/plural';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five alert categories produced by the alert centre. */
export type AlertKind = 'low-stock' | 'expiry' | 'maintenance-due' | 'warranty-due' | 'field-due';

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
  /** Optional item id — used to scroll-to + flash the item card on arrival. */
  readonly itemId?: string;
  /** The item's name — seeds the destination search so the item is loaded & on-screen. */
  readonly itemName?: string;
}

/**
 * The router destination an alert's "View" link navigates to: its route, plus the search params
 * that put the item on screen when it names one.
 *
 * The Inventory screen's whole view lives in its URL (issue #574), so an item alert is an
 * ordinary link to a filtered list rather than a handover the destination has to consume — the
 * link can be copied, opened in a new tab, and undone with Back like any other.
 */
export function alertTargetLink(target: AlertTarget): {
  readonly to: string;
  readonly search?: InventorySearchParams;
} {
  // Only the Inventory screen reads a search of this shape, so the name is spliced in for that
  // destination alone — and through the screen's own builder, never a literal here.
  return target.route === '/inventory' && target.itemName
    ? { to: target.route, search: inventorySearchFor(target.itemName) }
    : { to: target.route };
}

/**
 * A single proactive alert surfaced in the alert centre.
 *
 * The `id` is a pure function of the source entity and `now` — no render counter, nothing that
 * varies between two passes over the same data — because it is at once the dismissal key, the OS
 * notification tag and the React key. It identifies **this occurrence** of the condition rather
 * than the entity behind it: alongside the entity ids it carries the deadline the alert is about
 * and the urgency band it is in. Re-dating the deadline, or an alert escalating from a warning to
 * a critical one, therefore mints a **new** id, and a dismissal of the earlier occurrence no
 * longer applies (issue #644).
 *
 * Two lanes have no deadline to name an occurrence with — low stock, and a USAGE maintenance
 * schedule, whose id reads `undated` in that segment. For those, a dismissal is retired instead
 * by {@link pruneDismissals} once the condition is seen to have resolved.
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
// Display metadata (British English labels; tone/badge classes stay in the screen)
// ---------------------------------------------------------------------------

/**
 * Human-readable lane names, one per {@link AlertKind} — the alert centre's section headings.
 *
 * Lives here beside the type rather than in the screen so the alert **export** (issue #132)
 * labels a row exactly as the screen labels its section: one definition, no drift between what
 * the user reads and what the file says.
 */
export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  'low-stock': 'Low stock',
  expiry: 'Expiring stock',
  'maintenance-due': 'Maintenance due',
  'warranty-due': 'Warranty',
  'field-due': 'Custom field date',
};

/**
 * Every {@link AlertKind}, in lane order. Derived from {@link ALERT_KIND_LABEL} so a new lane
 * cannot be added to one and forgotten in the other.
 */
const ALERT_KINDS = Object.keys(ALERT_KIND_LABEL) as readonly AlertKind[];

/**
 * Recover the lane from an alert id, or `null` if it belongs to none.
 *
 * Every id begins `${kind}:`, so this is a prefix match rather than a parse — the rest of an id
 * is lane-specific and deliberately opaque. {@link pruneDismissals} needs it because a stored
 * dismissal is only an id: to judge whether its alert is genuinely gone it must know which
 * lane's feed to have seen. An id written by an older or newer build that named a lane this one
 * does not know grades `null` and is treated as unjudgeable, never as resolved.
 */
export function alertKindFromId(id: string): AlertKind | null {
  return ALERT_KINDS.find((kind) => id.startsWith(`${kind}:`)) ?? null;
}

/** Human-readable urgency names, one per {@link AlertSeverity} (shared with the export). */
export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

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
  /**
   * UNIX-ms **effective** expiry instant — the earlier of the item's own date and its earliest
   * stocked lot's, as `effectiveExpiryDate` resolves it (issue #684). Null = neither exists, and
   * the item is skipped. Named for what it carries rather than for the item column, because a
   * perishable received against a purchase order or a BOM is dated on its lot, not on its row.
   */
  readonly effectiveExpiryDate: number | null;
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

/**
 * One item's value for a custom `DATE` field its definition opted in as a due date (W1a).
 * Mirrors the repository's `FieldDueDate` projection; kept as its own minimal shape so the
 * seam stays free of the repository layer, exactly like the four lanes above.
 */
export interface FieldDueSource {
  readonly itemId: string;
  readonly itemName: string;
  /** The dictionary definition id — half of the alert's identity, since one item can have several. */
  readonly defId: string;
  /** The field's name as the user sees it on the item ("Renewal date"). */
  readonly fieldName: string;
  /** The definition's notice period in calendar days (`0` = "on the day"). */
  readonly leadDays: number;
  /** UNIX-ms midnight-UTC instant of the stored day. */
  readonly dueAt: number;
}

/** The five source arrays passed to `buildAlerts`. */
export interface AlertSources {
  readonly lowStock: readonly LowStockSource[];
  readonly expiring: readonly ExpirySource[];
  readonly maintenanceDue: readonly MaintenanceDueSource[];
  readonly warrantyItems: readonly WarrantySource[];
  readonly fieldDue: readonly FieldDueSource[];
}

// ---------------------------------------------------------------------------
// Formatting seam
// ---------------------------------------------------------------------------

/**
 * Renders the dates that appear in an alert's human copy. Injected — the way `buildAgenda` takes
 * an `AgendaDateFormatter` — rather than sliced from an ISO string here, so an alert names a date
 * in the user's locale, and on the day the seam says that value falls on (issue #497). Kept a
 * pure parameter so this seam stays free of React and preferences, and stays exhaustively
 * unit-testable.
 *
 * The two members are not interchangeable, and picking the wrong one is precisely the bug this
 * replaced. `Formatters` satisfies the shape structurally, so a caller passes `useFormatters()`.
 */
export interface AlertDateFormatters {
  /**
   * A genuine instant that carries a real local time-of-day — the maintenance lane's `dueAtMs`,
   * which `addCalendarDays` anchors to the wall-clock time the service was logged at (#325).
   * Rendered in the host zone, so an evening service west of UTC keeps its own calendar day.
   */
  readonly date: (ms: number) => string;
  /**
   * A **day-grained** value stored at midnight UTC — expiry, warranty and custom-field due
   * dates. Rendered in UTC, so the day the user picked is the day shown in every timezone.
   */
  readonly calendarDate: (ms: number) => string;
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
    severity: 'warning',
    title: `Low stock — ${item.name}`,
    detail: 'This item is at or below its reorder point.',
    dueAt: null,
    target: { route: '/inventory', itemId: item.id, itemName: item.name },
  }));
}

function buildExpiryAlerts(sources: readonly ExpirySource[], now: number, fmt: AlertDateFormatters): Alert[] {
  const alerts: Alert[] = [];
  for (const item of sources) {
    // An item with no date grades NONE and is skipped either way; settling it here also settles
    // the type, so the day below needs no "what if there is no date" fallback.
    if (item.effectiveExpiryDate == null) continue;

    const status = expiryStatus(item.effectiveExpiryDate, now);
    if (status === 'FRESH') continue;

    const expired = status === 'EXPIRED';
    const severity: AlertSeverity = expired ? 'critical' : 'warning';
    const dueAt = new Date(item.effectiveExpiryDate).toISOString();
    // The ISO day still keys the alert's identity — it must not vary with locale or timezone —
    // but the copy reads the shared formatter's rendering of the same day.
    const day = dueAt.slice(0, 10);
    const shown = fmt.calendarDate(item.effectiveExpiryDate);
    const detail = expired ? `Expiry date has passed (${shown}).` : `Expires soon on ${shown}.`;

    alerts.push({
      // The stored day and the status band both belong to the identity: "expiring soon" and the
      // "expired" it becomes are two occurrences, not one, so dismissing the nudge cannot silence
      // the critical alert it turns into — nor its reminder notification (issue #644).
      id: `expiry:${item.id}:${day}:${expired ? 'expired' : 'expiring-soon'}`,
      kind: 'expiry',
      severity,
      title: `${expired ? 'Expired' : 'Expiring soon'} — ${item.name}`,
      detail,
      dueAt,
      target: { route: '/inventory', itemId: item.id, itemName: item.name },
    });
  }
  return alerts;
}

function buildMaintenanceDueAlerts(
  sources: readonly MaintenanceDueSource[],
  now: number,
  fmt: AlertDateFormatters,
): Alert[] {
  return sources.map((schedule) => {
    const dueAt = schedule.dueAtMs != null ? new Date(schedule.dueAtMs).toISOString() : null;
    const overdue = schedule.dueAtMs != null && schedule.dueAtMs < now;
    return {
      // A TIME schedule's due day identifies the occurrence: logging the work moves the date on,
      // so the next time it falls due it is a new alert rather than one an old dismissal still
      // hides. A USAGE schedule has no due date and reads `undated` — {@link pruneDismissals}
      // retires its dismissal on resolution instead.
      id: `maintenance-due:${schedule.id}:${dueAt?.slice(0, 10) ?? 'undated'}:${overdue ? 'overdue' : 'due'}`,
      kind: 'maintenance-due',
      severity: overdue ? 'critical' : 'warning',
      title: `Maintenance due — ${schedule.itemName}`,
      // `dueAtMs` is a wall-clock instant, not a day-grained one, so the copy goes through
      // `date` and not `calendarDate` — reading its UTC components named the wrong day for a
      // service logged near midnight outside UTC, one day off the agenda and the calendar feed
      // for the very same schedule (issue #497). `alert-agenda-date-parity.test.ts` drives this
      // lane and `buildAgenda` over one schedule and fails if the two days ever part again.
      detail: `Schedule: "${schedule.name}"${schedule.dueAtMs != null ? `. Due ${fmt.date(schedule.dueAtMs)}.` : '.'}`,
      dueAt,
      target: { route: '/inventory', itemId: schedule.itemId, itemName: schedule.itemName },
    };
  });
}

function buildWarrantyAlerts(
  sources: readonly WarrantySource[],
  now: number,
  fmt: AlertDateFormatters,
): Alert[] {
  const alerts: Alert[] = [];
  for (const item of sources) {
    // Gate: items without warrantyExpiresAt produce no warranty alert (P66 field).
    if (item.warrantyExpiresAt == null) continue;

    const status = warrantyStatus(item, now);
    if (status === 'none' || status === 'active') continue;

    const dueAtMs = Date.parse(item.warrantyExpiresAt);
    const dueAt = Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : null;

    const severity: AlertSeverity = status === 'expired' ? 'critical' : 'warning';
    const shown = dueAt !== null ? fmt.calendarDate(dueAtMs) : null;
    const detail =
      status === 'expired'
        ? `Warranty expired${shown ? ` on ${shown}` : ''}.`
        : `Warranty expires soon${shown ? ` on ${shown}` : ''} (within ${WARRANTY_EXPIRING_SOON_DAYS} days).`;

    alerts.push({
      // The status band joins the stored date for the same reason the expiry lane carries it:
      // "expiring soon" escalating to "expired" is a second occurrence, and a dismissal of the
      // first must not silence it (issue #644).
      id: `warranty-due:${item.id}:${item.warrantyExpiresAt}:${status}`,
      kind: 'warranty-due',
      severity,
      title: `${status === 'expired' ? 'Warranty expired' : 'Warranty expiring soon'} — ${item.name}`,
      detail,
      dueAt,
      target: { route: '/inventory', itemId: item.id, itemName: item.name },
    });
  }
  return alerts;
}

/**
 * Custom-field due dates (W1a) — the lane that makes a user-defined `DATE` field do something.
 *
 * The repository has already narrowed the read to definitions that opted in and to dates
 * inside their own lead time; this re-grades each row through the pure {@link fieldDueStatus}
 * so the classification lives in one place and the SQL window and the alert can never disagree
 * about what "due" means. A row that grades `SCHEDULED` or `NONE` is skipped rather than
 * trusted from the query — the feed can be a cached page read minutes ago, and a date that has
 * since moved out of its window should stop alerting without waiting for a refetch.
 *
 * The id carries the stored date and the status band, like the warranty lane, so pushing a
 * deadline back gives the alert a new identity and lifts an earlier dismissal — a dismissed
 * "Renewal date" must not stay silent once the renewal is a year later, or (worse) once it is
 * brought forward, and dismissing "due soon" must not silence the overdue alert it becomes.
 */
function buildFieldDueAlerts(
  sources: readonly FieldDueSource[],
  now: number,
  fmt: AlertDateFormatters,
): Alert[] {
  const alerts: Alert[] = [];
  for (const source of sources) {
    const status = fieldDueStatus(source.dueAt, source.leadDays, now);
    if (status === 'NONE' || status === 'SCHEDULED') continue;

    const overdue = status === 'OVERDUE';
    const dueAt = new Date(source.dueAt).toISOString();
    // As in the expiry lane: the ISO day keys the identity, the formatter writes the copy.
    const day = dueAt.slice(0, 10);
    const shown = fmt.calendarDate(source.dueAt);
    alerts.push({
      id: `field-due:${source.itemId}:${source.defId}:${day}:${overdue ? 'overdue' : 'due-soon'}`,
      kind: 'field-due',
      severity: overdue ? 'critical' : 'warning',
      title: `${source.fieldName} ${overdue ? 'passed' : 'due soon'} — ${source.itemName}`,
      detail: overdue
        ? `"${source.fieldName}" was due on ${shown}.`
        : `"${source.fieldName}" is due on ${shown} (within ${source.leadDays} ${plural(source.leadDays, 'day')}).`,
      dueAt,
      target: { route: '/inventory', itemId: source.itemId, itemName: source.itemName },
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// buildAlerts — the primary export
// ---------------------------------------------------------------------------

/**
 * Fold the five alert sources into a single sorted `Alert[]`.
 *
 * Sorting rules (stable):
 * 1. Severity — critical before warning before info.
 * 2. `dueAt` — soonest ISO string first (nulls sort last).
 * 3. `id` — deterministic tie-break.
 *
 * @param sources - The five pre-fetched source arrays.
 * @param now     - Current wall-clock instant (UNIX-ms). Injected for testability.
 * @param fmt     - Date renderers for the human copy; see {@link AlertDateFormatters}.
 */
export function buildAlerts(sources: AlertSources, now: number, fmt: AlertDateFormatters): Alert[] {
  const all: Alert[] = [
    ...buildLowStockAlerts(sources.lowStock),
    ...buildExpiryAlerts(sources.expiring, now, fmt),
    ...buildMaintenanceDueAlerts(sources.maintenanceDue, now, fmt),
    ...buildWarrantyAlerts(sources.warrantyItems, now, fmt),
    ...buildFieldDueAlerts(sources.fieldDue, now, fmt),
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
 * One recorded dismissal: how long the alert stays hidden, and when the user said so.
 *
 * A plain dismissal is indefinite (`until: null`) — the alert only comes back if the user
 * restores it, or if the underlying condition changes enough to give it a new id. A *snooze*
 * sets `until` to the instant it should return, so "I have already ordered more, ask me again
 * next week" no longer means choosing between permanent silence and permanent nagging.
 */
export interface AlertDismissal {
  /** Epoch-ms at which the alert reappears; `null` = hidden until explicitly restored. */
  readonly until: number | null;
  /** Epoch-ms the dismissal was recorded — the age {@link pruneDismissals} measures. */
  readonly at: number;
}

/** Alert id → its dismissal record. */
export type AlertDismissals = ReadonlyMap<string, AlertDismissal>;

/** Is this record still hiding its alert at `now`? A snooze stops hiding once it elapses. */
function isHiding(dismissal: AlertDismissal, now: number): boolean {
  return dismissal.until === null || dismissal.until > now;
}

/**
 * How long a dismissal outlives the alert it silenced, in calendar days.
 *
 * "Not in the current feed" is not proof the condition is gone: a lane can be switched off in
 * the Modules manager, the warranty feed is capped, and every feed reads empty while it loads.
 * A record therefore gets this long a grace period before {@link pruneDismissals} drops it —
 * long enough that no ordinary gap evicts a live dismissal, short enough that a deleted item's
 * record does not sit in `localStorage` for the lifetime of the install.
 */
export const STALE_DISMISSAL_DAYS = 30;

/**
 * Filter out alerts that a dismissal is currently hiding.
 *
 * Dismissals are stored device-locally (Zustand persist) — see `useDismissedAlertsStore.ts`.
 * A re-triggered alert with a new id reappears, and a snoozed one reappears by itself once
 * `until` has passed.
 */
export function applyDismissals(alerts: readonly Alert[], dismissals: AlertDismissals, now: number): Alert[] {
  return alerts.filter((a) => {
    const dismissal = dismissals.get(a.id);
    return dismissal === undefined || !isHiding(dismissal, now);
  });
}

/**
 * Reconcile the dismissal records against the live alert feed, dropping the ones that can no
 * longer do anything (issue #134). Three records are dead weight:
 *
 *  - a **snooze that has elapsed** — its alert is already showing again, so there is nothing
 *    left to remember;
 *  - a record whose condition has **demonstrably resolved** — its alert is absent from a lane
 *    whose feed was read whole this pass, so the absence is a fact rather than a gap;
 *  - a record whose alert **has not fired for {@link STALE_DISMISSAL_DAYS}** — the fallback for
 *    every absence that is *not* demonstrable.
 *
 * Without this the set only ever grew: an id dismissed once stayed in `localStorage` forever,
 * even after its item was deleted. This is the same reconcile-against-the-feed shape
 * `planReminders` uses to bound `useNotifiedRemindersStore`.
 *
 * The middle rule is what lets a **recurring** condition alert again (issue #644). A dismissal
 * silences one occurrence, and the lanes that can say which occurrence do so in the id — but
 * low stock has no deadline to put there, and neither has a USAGE maintenance schedule. Restock
 * a dismissed item and run it down again inside the grace period and the alert used to come back
 * already hidden. Retiring the record the moment its condition is seen to have gone fixes that
 * without weakening the grace period, which still covers every absence that proves nothing: a
 * lane switched off in the Modules manager, a feed still loading, and a capped feed whose rows
 * ran past the page ceiling.
 *
 * @param liveIds - Ids of every alert currently produced by the feed (before dismissal filtering).
 * @param completeKinds - Lanes whose feed was fetched, settled **and** read to the end this pass.
 *   A lane left out is simply not judged — absence from it means nothing. Omit the argument
 *   entirely and only the staleness rule applies, which is what every caller got before.
 * @returns The pruned map, or `null` when nothing needed dropping — so a caller can skip the
 *          store write, and an effect driving this can never loop on its own update.
 */
export function pruneDismissals(
  dismissals: AlertDismissals,
  liveIds: ReadonlySet<string>,
  now: number,
  completeKinds: ReadonlySet<AlertKind> = new Set(),
): AlertDismissals | null {
  const staleBefore = addCalendarDays(now, -STALE_DISMISSAL_DAYS);
  const kept = new Map<string, AlertDismissal>();
  for (const [id, dismissal] of dismissals) {
    if (!isHiding(dismissal, now)) continue;
    if (liveIds.has(id)) {
      kept.set(id, dismissal);
      continue;
    }
    // Absent. Drop it if the lane it belongs to was read whole (so the condition really has
    // resolved), or if it has been absent long enough for the grace period to have run out.
    const kind = alertKindFromId(id);
    if (kind !== null && completeKinds.has(kind)) continue;
    if (dismissal.at <= staleBefore) continue;
    kept.set(id, dismissal);
  }
  // Records are only ever dropped, never added or altered, so the size settles the question.
  return kept.size === dismissals.size ? null : kept;
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
  // Calendar-day arithmetic (issue #325) — the pure twin of `maintenanceStatus` and the stored
  // `time_due_at` the repository writes; all three must agree on the due instant.
  return addCalendarDays(anchor, intervalDays);
}
