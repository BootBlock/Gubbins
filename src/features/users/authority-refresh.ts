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
 *
 * "Edited" includes an edit made somewhere else and *arriving* here — `users`, `roles` and
 * `api_tokens` are synced tables, so a merge, a backup restore or a conflict restore can change
 * any of them without this device touching the admin screens (issue #631). Those paths go
 * through {@link adoptAuthorityChange}.
 */
import type { QueryClient } from '@tanstack/react-query';
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

/**
 * Adopt rows that arrived from elsewhere: re-resolve the authority, then drop every cached read.
 *
 * The whole-database paths — a sync merge, a backup restore, a conflict restore — replace rows
 * of `users` and `roles` just as the admin screens do, but nothing about *this* device's session
 * changes, so neither the sign-in gate's effect nor a mutation hook re-runs. Without this the
 * device keeps writing under the permissions it started with until the next reload: a role
 * narrowed, an account disabled, or an account deleted on another device has no effect here
 * (issue #631).
 *
 * The order matches `refreshAfterWrite` in `mutations.ts` — refresh first, so the refetches the
 * invalidation triggers run under the new permissions rather than the ones being replaced. The
 * invalidation is unscoped because the caller has just replaced arbitrary tables, not because
 * the authority needs it.
 */
export async function adoptAuthorityChange(client: QueryClient): Promise<void> {
  await refreshAuthority();
  await client.invalidateQueries();
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
