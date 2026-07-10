import { describe, it, expect } from 'vitest';
import type { Alert, AlertKind } from './alerts';
import {
  planReminders,
  periodicSyncAction,
  normaliseReminderKinds,
  DEFAULT_REMINDER_KINDS,
  REMINDER_SUMMARY_THRESHOLD,
  REMINDER_KINDS,
  type ReminderKinds,
  type ReminderSettings,
  type ReminderEnvironment,
  type ReminderPermission,
} from './reminders';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal alert; only the fields the seam reads are meaningful. */
function alert(id: string, kind: AlertKind = 'low-stock', overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    kind,
    severity: 'warning',
    title: `Alert ${id}`,
    detail: `Detail ${id}`,
    dueAt: null,
    target: { route: '/inventory', itemId: id, itemName: `Item ${id}` },
    ...overrides,
  };
}

const ALL_KINDS_ON: ReminderKinds = { ...DEFAULT_REMINDER_KINDS };

function settings(over: Partial<ReminderSettings> = {}): ReminderSettings {
  return { enabled: true, kinds: ALL_KINDS_ON, ...over };
}

function env(permission: ReminderPermission = 'granted', supported = true): ReminderEnvironment {
  return { supported, permission };
}

// ---------------------------------------------------------------------------
// Quiet cases — nothing fires
// ---------------------------------------------------------------------------

describe('planReminders — quiet cases', () => {
  it('fires nothing when the platform is unsupported', () => {
    const plan = planReminders([alert('a')], settings(), env('granted', false), new Set());
    expect(plan.toFire).toEqual([]);
  });

  it('fires nothing when permission is default (not yet asked)', () => {
    const plan = planReminders([alert('a')], settings(), env('default'), new Set());
    expect(plan.toFire).toEqual([]);
  });

  it('fires nothing when permission is denied', () => {
    const plan = planReminders([alert('a')], settings(), env('denied'), new Set());
    expect(plan.toFire).toEqual([]);
  });

  it('fires nothing when the master opt-in is off', () => {
    const plan = planReminders([alert('a')], settings({ enabled: false }), env('granted'), new Set());
    expect(plan.toFire).toEqual([]);
  });

  it('still prunes resolved ids from the notified set while quiet', () => {
    // 'gone' has no live alert; 'a' does. Even disabled, the persisted set is reconciled.
    const plan = planReminders(
      [alert('a')],
      settings({ enabled: false }),
      env('granted'),
      new Set(['a', 'gone']),
    );
    expect(plan.toFire).toEqual([]);
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a']));
  });
});

// ---------------------------------------------------------------------------
// Happy path — individual reminders
// ---------------------------------------------------------------------------

describe('planReminders — firing', () => {
  it('fires one reminder per new alert (at or below the summary threshold)', () => {
    const alerts = [alert('a'), alert('b'), alert('c')];
    expect(alerts.length).toBe(REMINDER_SUMMARY_THRESHOLD);
    const plan = planReminders(alerts, settings(), env(), new Set());

    expect(plan.toFire.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('carries the alert id, title, detail and target onto the planned reminder', () => {
    const only = alert('x', 'warranty-due', {
      title: 'Warranty expiring — Drill',
      detail: 'Warranty expires soon on 2026-08-01.',
      target: { route: '/inventory', itemId: 'x', itemName: 'Drill' },
    });
    const [reminder] = planReminders([only], settings(), env(), new Set()).toFire;

    expect(reminder).toEqual({
      id: 'x',
      kind: 'warranty-due',
      title: 'Warranty expiring — Drill',
      body: 'Warranty expires soon on 2026-08-01.',
      target: { route: '/inventory', itemId: 'x', itemName: 'Drill' },
    });
  });

  it('does not re-fire an already-notified alert', () => {
    const plan = planReminders([alert('a'), alert('b')], settings(), env(), new Set(['a']));
    expect(plan.toFire.map((r) => r.id)).toEqual(['b']);
    // 'a' stays notified; 'b' joins it.
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a', 'b']));
  });

  it('fires nothing (but keeps the set) when every alert is already notified', () => {
    const plan = planReminders([alert('a'), alert('b')], settings(), env(), new Set(['a', 'b']));
    expect(plan.toFire).toEqual([]);
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a', 'b']));
  });
});

// ---------------------------------------------------------------------------
// Per-kind opt-in
// ---------------------------------------------------------------------------

describe('planReminders — per-kind opt-in', () => {
  it('excludes a lane that is switched off, and does not mark it notified', () => {
    const kinds: ReminderKinds = { ...ALL_KINDS_ON, expiry: false };
    const alerts = [alert('a', 'low-stock'), alert('e', 'expiry')];
    const plan = planReminders(alerts, settings({ kinds }), env(), new Set());

    expect(plan.toFire.map((r) => r.id)).toEqual(['a']);
    // 'e' is not fired and is NOT recorded, so enabling the lane later will fire it.
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a']));
  });

  it('fires a previously-suppressed lane once the user enables it', () => {
    const alerts = [alert('e', 'expiry')];
    // First pass: expiry off → nothing recorded.
    const off = planReminders(
      alerts,
      settings({ kinds: { ...ALL_KINDS_ON, expiry: false } }),
      env(),
      new Set(),
    );
    expect(off.toFire).toEqual([]);
    // Second pass: expiry on, carrying the previous (empty-for-e) notified set → it now fires.
    const on = planReminders(alerts, settings(), env(), new Set(off.nextNotified));
    expect(on.toFire.map((r) => r.id)).toEqual(['e']);
  });
});

// ---------------------------------------------------------------------------
// Summary collapse
// ---------------------------------------------------------------------------

describe('planReminders — summary collapse', () => {
  it('collapses to a single summary above the threshold', () => {
    const alerts = Array.from({ length: REMINDER_SUMMARY_THRESHOLD + 1 }, (_, i) => alert(`a${i}`));
    const plan = planReminders(alerts, settings(), env(), new Set());

    expect(plan.toFire).toHaveLength(1);
    const [summary] = plan.toFire;
    expect(summary.kind).toBe('summary');
    expect(summary.id).toBe('reminders:summary');
    expect(summary.body).toContain(String(REMINDER_SUMMARY_THRESHOLD + 1));
    expect(summary.target).toEqual({ route: '/alerts' });

    // All the underlying alerts are still marked notified so they won't re-summarise.
    expect(new Set(plan.nextNotified)).toEqual(new Set(alerts.map((a) => a.id)));
  });

  it('counts only genuinely-new alerts toward the threshold', () => {
    // 4 alerts, 2 already notified → 2 new → below threshold → individual, not summary.
    const alerts = [alert('a'), alert('b'), alert('c'), alert('d')];
    const plan = planReminders(alerts, settings(), env(), new Set(['a', 'b']));
    expect(plan.toFire.map((r) => r.id)).toEqual(['c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation / bounding of the notified set
// ---------------------------------------------------------------------------

describe('planReminders — notified-set reconciliation', () => {
  it('drops a resolved id so a recurrence notifies again', () => {
    // 'a' was notified but is no longer in the feed (resolved).
    const resolved = planReminders([alert('b')], settings(), env(), new Set(['a', 'b']));
    expect(new Set(resolved.nextNotified)).toEqual(new Set(['b']));

    // 'a' recurs later with the same id → it fires again.
    const recurs = planReminders([alert('a'), alert('b')], settings(), env(), new Set(resolved.nextNotified));
    expect(recurs.toFire.map((r) => r.id)).toEqual(['a']);
  });

  it('keeps the notified set bounded by the live alert set', () => {
    const notified = new Set(['x1', 'x2', 'x3']); // none live
    const plan = planReminders([alert('a')], settings(), env(), notified);
    expect(new Set(plan.nextNotified)).toEqual(new Set(['a']));
  });
});

// ---------------------------------------------------------------------------
// periodicSyncAction
// ---------------------------------------------------------------------------

describe('periodicSyncAction', () => {
  const base = {
    enabled: true,
    permission: 'granted' as ReminderPermission,
    supported: true,
    registered: false,
  };

  it('registers when wanted and not yet registered', () => {
    expect(periodicSyncAction(base)).toBe('register');
  });

  it('does nothing when wanted and already registered', () => {
    expect(periodicSyncAction({ ...base, registered: true })).toBe('none');
  });

  it('unregisters when no longer wanted but still registered', () => {
    expect(periodicSyncAction({ ...base, enabled: false, registered: true })).toBe('unregister');
    expect(periodicSyncAction({ ...base, permission: 'denied', registered: true })).toBe('unregister');
  });

  it('does nothing when unsupported', () => {
    expect(periodicSyncAction({ ...base, supported: false })).toBe('none');
    expect(periodicSyncAction({ ...base, supported: false, registered: true })).toBe('unregister');
  });

  it('does nothing when not wanted and not registered', () => {
    expect(periodicSyncAction({ ...base, enabled: false })).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// normaliseReminderKinds
// ---------------------------------------------------------------------------

describe('normaliseReminderKinds', () => {
  it('defaults everything on when undefined', () => {
    expect(normaliseReminderKinds(undefined)).toEqual(DEFAULT_REMINDER_KINDS);
  });

  it('fills a missing lane with its default (on)', () => {
    const result = normaliseReminderKinds({ 'low-stock': false });
    expect(result['low-stock']).toBe(false);
    expect(result.expiry).toBe(true);
    expect(result['maintenance-due']).toBe(true);
    expect(result['warranty-due']).toBe(true);
  });

  it('ignores non-boolean and unknown values', () => {
    const result = normaliseReminderKinds({ expiry: 'yes' as unknown as boolean, bogus: true });
    expect(result.expiry).toBe(true); // non-boolean ignored → default
    expect(Object.keys(result).sort()).toEqual([...REMINDER_KINDS].sort());
    expect((result as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('always returns a total map (every known lane present)', () => {
    const result = normaliseReminderKinds({});
    for (const kind of REMINDER_KINDS) expect(typeof result[kind]).toBe('boolean');
  });
});
