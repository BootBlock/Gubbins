/**
 * Local reminder-notification pure seam (G3, spec §3 alert centre → PWA-native delivery).
 *
 * The alert centre already folds low stock, perishable expiry, maintenance-due and
 * warranty-due into a sorted `Alert[]` ({@link ./alerts}). Its only delivery surface is
 * in-app. For an **installed** PWA this seam decides which of those alerts should fire an
 * **OS notification right now** — purely, with no DOM, no Notification API and no storage
 * access — so the "what fires now" decision is exhaustively unit-testable out of glue,
 * mirroring `reorder-policy.ts` / `cycle-count.ts` / `wake-lock.ts`.
 *
 * The delivery itself (Notification API + service worker), the permission request, and the
 * device-local "already notified" set are the glue in {@link ./reminder-api},
 * {@link ./useReminderNotifications} and {@link ./useNotifiedRemindersStore}.
 *
 * **Local only — never Web Push.** This is a backend-less PWA; there is no push server. A
 * reminder is shown from the device while the app (or, where Periodic Background Sync is
 * present, its service worker) is alive. Where the Notification API is absent or permission
 * is denied (e.g. iOS Safari), every branch here degrades to "fire nothing", never a throw.
 */

import type { Alert, AlertKind, AlertTarget } from './alerts';

// ---------------------------------------------------------------------------
// Kinds — the per-lane opt-in surface
// ---------------------------------------------------------------------------

/** Every alert lane, in the order the Settings per-kind controls list them. */
export const REMINDER_KINDS = [
  'low-stock',
  'expiry',
  'maintenance-due',
  'warranty-due',
] as const satisfies readonly AlertKind[];

/** Whether each alert lane is allowed to fire a reminder notification. */
export type ReminderKinds = Record<AlertKind, boolean>;

/** All lanes on — the default once reminders are enabled (opt-in as a whole). */
export const DEFAULT_REMINDER_KINDS: ReminderKinds = {
  'low-stock': true,
  expiry: true,
  'maintenance-due': true,
  'warranty-due': true,
};

/** Human-readable lane names for the Settings controls (SSOT for reminder copy). */
export const REMINDER_KIND_LABELS: Record<AlertKind, string> = {
  'low-stock': 'Low stock',
  expiry: 'Expiring stock',
  'maintenance-due': 'Maintenance due',
  'warranty-due': 'Warranty',
};

/**
 * Coerce an arbitrary persisted map (possibly partial, or from an older/newer build that
 * knew a different set of lanes) into a complete, valid {@link ReminderKinds}. Every known
 * lane gets an explicit boolean; a missing lane defaults to **on** (matching
 * {@link DEFAULT_REMINDER_KINDS}); an unknown key is dropped. Kept total so a stale
 * localStorage value can never leave a lane `undefined` at the decision site.
 */
export function normaliseReminderKinds(value: Partial<Record<string, unknown>> | undefined): ReminderKinds {
  const out = { ...DEFAULT_REMINDER_KINDS };
  for (const kind of REMINDER_KINDS) {
    const raw = value?.[kind];
    if (typeof raw === 'boolean') out[kind] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings & environment inputs
// ---------------------------------------------------------------------------

/** The user's reminder preferences (Tier-2, `usePreferencesStore`). */
export interface ReminderSettings {
  /** Master opt-in. Off by default — reminders are entirely opt-in. */
  readonly enabled: boolean;
  /** Per-lane opt-in; a lane that is `false` never fires. */
  readonly kinds: ReminderKinds;
}

/**
 * Permission state, mirroring the Notification API's `NotificationPermission`
 * (`'default'` = not yet asked). Modelled explicitly so the seam never touches the DOM.
 */
export type ReminderPermission = 'default' | 'granted' | 'denied';

/** The platform capabilities the decision depends on (feature-detected in the glue). */
export interface ReminderEnvironment {
  /** The Notification API + a service worker are both present. */
  readonly supported: boolean;
  /** Current notification permission for this origin. */
  readonly permission: ReminderPermission;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * A single notification to display now. `id` doubles as the OS notification **tag** so a
 * re-fire for the same underlying condition replaces (rather than stacks) its predecessor.
 */
export interface PlannedReminder {
  /** The originating alert id (or a summary id); used as the notification tag. */
  readonly id: string;
  readonly kind: AlertKind | 'summary';
  readonly title: string;
  readonly body: string;
  /** Deep-link target the notification click resolves to. */
  readonly target: AlertTarget;
}

/**
 * The outcome of a planning pass:
 * - `toFire` — the notifications to display this pass (empty when quiet or nothing new).
 * - `nextNotified` — the reconciled "already notified" id set to persist: previously-notified
 *   ids that are **still active** (resolved conditions are dropped so a recurrence re-fires),
 *   unioned with everything newly fired. Bounded by the live alert set, so it never grows
 *   without limit.
 */
export interface ReminderPlan {
  readonly toFire: readonly PlannedReminder[];
  readonly nextNotified: readonly string[];
}

/**
 * Above this many genuinely-new reminders in one pass, a single **summary** notification is
 * shown instead of one-per-item — so enabling reminders on a busy inventory (or a long time
 * away) can never unleash a storm of OS notifications. All the new ids are still marked
 * notified, so the individual conditions won't re-summarise on the next pass.
 */
export const REMINDER_SUMMARY_THRESHOLD = 3;

/** The alert centre — where a summary reminder (and any lane without a specific item) points. */
const ALERT_CENTRE_TARGET: AlertTarget = { route: '/alerts' };

function toPlanned(alert: Alert): PlannedReminder {
  return {
    id: alert.id,
    kind: alert.kind,
    title: alert.title,
    body: alert.detail,
    target: alert.target,
  };
}

function summaryReminder(count: number): PlannedReminder {
  return {
    id: 'reminders:summary',
    kind: 'summary',
    title: 'Gubbins reminders',
    body: `${count} items need your attention.`,
    target: ALERT_CENTRE_TARGET,
  };
}

/**
 * Decide which reminders to fire now and what the next "already notified" set should be.
 *
 * Quiet (returns no notifications) when the platform is unsupported, permission is not
 * `granted`, or the master opt-in is off. Otherwise fires every alert whose lane is opted-in
 * and whose id has not already been notified — collapsing to a single summary above
 * {@link REMINDER_SUMMARY_THRESHOLD}. `nextNotified` is always reconciled to the live alert
 * set so a resolved-then-recurring condition notifies again and the set stays bounded.
 *
 * @param alerts   The current (undismissed) alert feed from the alert centre.
 * @param settings The user's reminder preferences.
 * @param env      Feature-detected platform capabilities + permission.
 * @param notified The device-local set of alert ids already notified.
 */
export function planReminders(
  alerts: readonly Alert[],
  settings: ReminderSettings,
  env: ReminderEnvironment,
  notified: ReadonlySet<string>,
): ReminderPlan {
  // Reconcile the notified set down to ids that still have a live alert; a condition that has
  // since resolved drops out, so if it recurs (same deterministic id) it will notify again.
  const liveIds = new Set(alerts.map((a) => a.id));
  const kept: string[] = [];
  for (const id of notified) if (liveIds.has(id)) kept.push(id);

  const quiet = !env.supported || env.permission !== 'granted' || !settings.enabled;
  if (quiet) return { toFire: [], nextNotified: kept };

  const keptSet = new Set(kept);
  // Genuinely-new, opted-in alerts (in the feed's existing severity/dueAt order).
  const pending = alerts.filter((a) => settings.kinds[a.kind] && !keptSet.has(a.id));
  if (pending.length === 0) return { toFire: [], nextNotified: kept };

  const toFire =
    pending.length > REMINDER_SUMMARY_THRESHOLD ? [summaryReminder(pending.length)] : pending.map(toPlanned);

  // Mark every new alert notified (even under a summary) so it won't re-fire next pass.
  const nextNotified = [...kept, ...pending.map((a) => a.id)];
  return { toFire, nextNotified };
}

// ---------------------------------------------------------------------------
// Periodic Background Sync — pure registration reconciliation
// ---------------------------------------------------------------------------

/** What to do about the Periodic Background Sync registration this pass. */
export type PeriodicSyncAction = 'register' | 'unregister' | 'none';

/** The inputs the periodic-sync decision depends on (all feature-detected in the glue). */
export interface PeriodicSyncSituation {
  /** The master reminder opt-in. */
  readonly enabled: boolean;
  /** Notification permission — periodic sync is pointless without it. */
  readonly permission: ReminderPermission;
  /** The Periodic Background Sync API is present. */
  readonly supported: boolean;
  /** A periodic-sync registration for our tag already exists. */
  readonly registered: boolean;
}

/**
 * Reconcile the desired periodic-sync registration against what exists — the wake-lock
 * `wakeLockAction` pattern. We want a background wake only when the platform supports it,
 * reminders are enabled, and permission is granted; otherwise the registration is torn down.
 */
export function periodicSyncAction(situation: PeriodicSyncSituation): PeriodicSyncAction {
  const want = situation.supported && situation.enabled && situation.permission === 'granted';
  if (want && !situation.registered) return 'register';
  if (!want && situation.registered) return 'unregister';
  return 'none';
}
