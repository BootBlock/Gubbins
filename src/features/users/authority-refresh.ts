/**
 * Recompute what the current session may do, from the database (issue #79, plan §3).
 *
 * The repository layer asks for an authority **synchronously** — a guard cannot await mid-write
 * — but resolving one means reading a user and their role, which is asynchronous. This module
 * is the seam between the two: it does the async work and caches the answer in the session
 * store, which the repositories then read for free.
 *
 * Everything that decides permission is re-read here rather than trusted from storage. The
 * persisted session carries an id and a name and nothing else, so a device that edits its own
 * localStorage can at most claim to be a different *existing* user — whose real role, enabled
 * state and grants are then loaded from the database and applied.
 *
 * It must be called whenever the inputs change: after signing in or out, after the module is
 * toggled, and after a user or role is edited. Missing a call leaves a stale authority, which
 * is why the sign-in path and the module toggle both go through it rather than setting the
 * store directly.
 */
import { getRoleRepository, getUserRepository } from '@/db/repositories';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { usersModuleEnabled } from './module';
import { resolveAuthority, UNRESTRICTED_AUTHORITY, type Authority } from './permissions';

/** The resolved pair: what the session may do, and who its writes are attributed to. */
export interface ResolvedSession {
  readonly authority: Authority;
  readonly actorId: string;
}

/**
 * Resolve the current session against the database and store the result.
 *
 * With the module off this short-circuits to unrestricted/Admin without touching the database
 * — the overwhelmingly common case, and the one that must stay free.
 */
export async function refreshAuthority(): Promise<ResolvedSession> {
  const resolved = await computeAuthority().catch(() => {
    // Never reject, and never leave the previous answer standing. A read can fail for reasons
    // that say nothing about who is signed in — a database briefly unavailable, an evicted
    // worker — and the store's default is *unrestricted*, so "give up and keep what's there"
    // would hand a fresh page load full access. If authority cannot be established it is
    // denied; a reload re-resolves it.
    return { authority: DENIED_AUTHORITY, actorId: ADMIN_USER_ID };
  });
  useSessionStore.getState().setResolved(resolved.authority, resolved.actorId);
  return resolved;
}

/** What an unresolvable session is permitted to do: nothing. */
const DENIED_AUTHORITY: Authority = { mode: 'denied', reason: 'signed-out' };

async function computeAuthority(): Promise<ResolvedSession> {
  if (!usersModuleEnabled()) {
    return { authority: UNRESTRICTED_AUTHORITY, actorId: ADMIN_USER_ID };
  }

  const session = useSessionStore.getState().session;
  if (!session) {
    return { authority: resolveAuthority({ moduleEnabled: true }), actorId: ADMIN_USER_ID };
  }

  const user = await getUserRepository().getById(session.userId);
  if (!user) {
    // The account was deleted (possibly on another device, arriving by sync) while this device
    // still held a session for it. Deny rather than fall back to Admin: a signed-in state that
    // silently becomes full access is precisely the failure this feature exists to prevent.
    return { authority: resolveAuthority({ moduleEnabled: true }), actorId: ADMIN_USER_ID };
  }

  const role = user.roleId ? await getRoleRepository().getById(user.roleId) : undefined;
  const authority = resolveAuthority({
    moduleEnabled: true,
    user: { id: user.id, kind: user.kind, isEnabled: user.isEnabled },
    grants: role?.permissions,
  });

  // Attribution follows the signed-in user even when their authority denies everything: a
  // disabled account's few remaining writes are still theirs, and recording them as Admin
  // would put another person's name on them.
  return { authority, actorId: user.id };
}
