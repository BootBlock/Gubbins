/**
 * The permission guard for the paths that do **not** go through a repository (issue #519).
 *
 * `BaseRepository.assertPermission` covers every gated mutation that reaches the driver through
 * a repository. A handful of bulk operations deliberately do not: the Danger-Zone erase and the
 * backup restore compose their own statements and hand them straight to the driver, precisely so
 * they can run set-based SQL a repository has no method for. That is a good reason to bypass the
 * repository and no reason at all to bypass the check, so they call this instead — same key set,
 * same `PERMISSION_DENIED` error, so the UI's existing error handling reports it identically.
 *
 * The authority is passed **in** rather than read from the session store here, for the same
 * reason the repositories take a `resolveAuthority` option: the callers are pure, injectable
 * engines that are driven in unit tests without a store. {@link currentAuthority} is the one
 * place the live store is read, and only production wiring calls it.
 */
import { DbError } from '@/db/errors';
import { useSessionStore } from '@/state/stores/useSessionStore';
import type { PermissionKey } from './permission-registry';
import { can, type Authority } from './permissions';

/** The authority of the session running right now, for production wiring only. */
export function currentAuthority(): Authority {
  return useSessionStore.getState().authority;
}

/**
 * The refusal itself, worded exactly as the repository guard words it so a caller cannot tell
 * (and need not care) which of the two boundaries turned it down.
 */
export function permissionDeniedError(key: PermissionKey): DbError {
  return new DbError('PERMISSION_DENIED', `You do not have permission to do this (${key}).`);
}

/**
 * Refuse unless `authority` holds **every** key in `keys`. Throws on the first missing key, so
 * the message names something the user can act on rather than the whole list.
 */
export function assertPermissions(authority: Authority, keys: readonly PermissionKey[]): void {
  for (const key of keys) {
    if (!can(authority, key)) throw permissionDeniedError(key);
  }
}
