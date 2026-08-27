/**
 * The store-side backstop on switching the Users module off (issue #630).
 *
 * Issue #429 closed the Modules screen, the first-run chooser and the "module hidden"
 * interstitial behind `modules:write`, because switching the Users module off takes the sign-in
 * gate down with it and resolves every session back to unrestricted. That is the gate, and it is
 * applied at each of those doors.
 *
 * This is the same rule stated once more where the write actually lands. The three doors are
 * three separate `usePermission` calls in three components, and a fourth door added later would
 * be ungated until somebody remembered — the same shape as the repository layer's
 * `assertPermission`, which exists so that hiding a control is a courtesy rather than the only
 * check. Nothing here loosens what #429 did; it refuses a write those gates would already have
 * refused.
 *
 * **A signed-out device always passes.** The sign-in screen's "Can't sign in?" hatch writes the
 * very same intent, and it is the documented way back in after a forgotten password. Its session
 * resolves to a *denied* authority, so a check on the authority alone would close the one door
 * that must stay open. Being signed in with a role that grants nothing is not that state, and is
 * refused — such an account can sign out, which puts the hatch back in front of it.
 *
 * This is a boundary between people sharing a device, not a lock: anybody may sign out and take
 * the hatch. What it stops is the gate coming down *quietly, mid-session*, while the activity log
 * goes on naming somebody who is no longer being constrained.
 *
 * Pure and session-injected, like the erase catalog's guards: the store binds it to the live
 * session, and the tests drive it with a session of their own.
 */
import { can, type Authority } from '@/features/users/permissions';
import type { PermissionKey } from '@/features/users/permission-registry';
import { FEATURE_REGISTRY, type FeatureId } from './feature-registry';
import { resolveEnabled } from './modules-graph';

/** The Modular UI id of the Users module — the sign-in and permission gate. */
export const USERS_FEATURE_ID: FeatureId = 'users';

/** What a signed-in session must hold to lift the sign-in gate. The key #429 introduced. */
export const USERS_MODULE_DISABLE_PERMISSION: PermissionKey = 'modules:write';

/** Who is asking. Both halves are needed — see {@link mayDisableUsersModule}. */
export interface UsersModuleGuardSession {
  /** What the session may do. */
  readonly authority: Authority;
  /** Whether anybody is signed in on this device at all. */
  readonly signedIn: boolean;
}

/**
 * Whether this session may switch the Users module off.
 *
 * A signed-out device always may — that is the lockout escape hatch. Otherwise it takes
 * {@link USERS_MODULE_DISABLE_PERMISSION}, which single-user mode holds unconditionally because
 * its authority resolves unrestricted.
 */
export function mayDisableUsersModule(session: UsersModuleGuardSession): boolean {
  return !session.signedIn || can(session.authority, USERS_MODULE_DISABLE_PERMISSION);
}

/**
 * Apply the guard to a proposed intent record: identical to `next`, except that a change which
 * would switch the Users module off without permission keeps it on.
 *
 * Pinning rather than rejecting the whole change is deliberate. A preset (or the first-run
 * chooser) turns every optional feature off that it does not list, and `users` is never listed —
 * so refusing the preset outright would take a leaner-app choice away over a module the preset
 * was never really about.
 *
 * The effective on/off state is resolved through the same engine the app reads with, rather than
 * by re-implementing "a missing key means the registry default" here.
 */
export function guardUsersIntent(
  current: Readonly<Record<string, boolean>>,
  next: Readonly<Record<string, boolean>>,
  session: UsersModuleGuardSession,
): Readonly<Record<string, boolean>> {
  const wasOn = resolveEnabled(current, FEATURE_REGISTRY).has(USERS_FEATURE_ID);
  const willBeOn = resolveEnabled(next, FEATURE_REGISTRY).has(USERS_FEATURE_ID);
  // Only the on → off transition is gated. Switching it on has its own confirmation, and a
  // change that leaves it where it is asks nothing of the session.
  if (!wasOn || willBeOn) return next;
  if (mayDisableUsersModule(session)) return next;
  return { ...next, [USERS_FEATURE_ID]: true };
}
