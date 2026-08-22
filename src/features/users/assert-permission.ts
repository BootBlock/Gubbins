/**
 * The permission refusal itself, shared by every boundary that raises one (issue #519).
 *
 * `BaseRepository.assertPermission` covers every gated mutation that reaches the driver through
 * a repository. A handful of bulk operations deliberately do not: the Danger-Zone erase and the
 * backup restore compose their own statements and hand them straight to the driver, precisely so
 * they can run set-based SQL a repository has no method for. That is a good reason to bypass the
 * repository and no reason at all to bypass the check, so they call this instead — and the
 * repository guard raises the *same* error from here, so the wording cannot drift between the
 * two and the UI's existing handling reports both identically.
 *
 * **No store, no React, no `src/db/repositories` import.** `base.ts` imports this, and `base.ts`
 * is in the graph the Bridge loads through Node's strip-only loader. Reading the live session is
 * therefore a separate module (`current-authority.ts`) that only the app's own wiring calls.
 */
import { DbError } from '@/db/errors';
import type { PermissionKey } from './permission-registry';
import { can, type Authority } from './permissions';

/**
 * The refusal a caller sees when a permission is missing. One wording, one code, one place —
 * a caller cannot tell (and need not care) which boundary turned it down.
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
