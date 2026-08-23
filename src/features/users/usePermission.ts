/**
 * Read API for the permission engine (issue #79 §2.3, issue #522).
 *
 * Thin React hooks over the pure `can` seam and the session store's derived `authority` —
 * the same shape as `useFeature` is over the Modular UI engine, and for the same reason: a
 * component asks "may this session do this?" without reaching into the store's internals or
 * re-deriving an authority of its own.
 *
 * The authority defaults to `unrestricted`, which is what single-user mode resolves to, so
 * every one of these answers `true` until an operator switches the Users module on and signs
 * in as a restricted account.
 *
 * **This gates the UI, not the data.** Hiding a screen is a courtesy — the boundary is
 * `BaseRepository.assertPermission`, which no rendered component can be routed around, and
 * neither is a lock on the database file itself (plan §1.1).
 */
import { useCallback } from 'react';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { can, canAny, type Authority } from './permissions';
import type { PermissionKey } from './permission-registry';

/** The current session's resolved authority (subscribes to the store). */
function useAuthority(): Authority {
  return useSessionStore((state) => state.authority);
}

/**
 * Whether the current session holds `key` — or, given several, **any** of them.
 *
 * `undefined` answers `true`: a screen or action that declares no permission is ungated, so
 * callers can pass an optional registry field straight in without a branch of their own. An
 * empty list answers `true` for the same reason.
 */
export function usePermission(key: PermissionKey | readonly PermissionKey[] | undefined): boolean {
  const authority = useAuthority();
  return holds(authority, key);
}

/**
 * A stable predicate over the current authority, for the callers that test many keys in one
 * render — the navigation menu, the command palette and the Dashboard tile grid each filter a
 * whole destination list. Calling {@link usePermission} once per row is not an option there
 * (rules of hooks), and each would otherwise re-read the store.
 */
export function usePermissionCheck(): (key: PermissionKey | readonly PermissionKey[] | undefined) => boolean {
  const authority = useAuthority();
  return useCallback((key) => holds(authority, key), [authority]);
}

/**
 * The shared answer both hooks give. Several keys mean **any** of them suffices — the form a
 * screen hosting more than one capability needs (Sync carries both cloud sync and Backup &
 * restore), and the reason this is not simply `can`.
 */
function holds(authority: Authority, key: PermissionKey | readonly PermissionKey[] | undefined): boolean {
  if (key === undefined) return true;
  return typeof key === 'string' ? can(authority, key) : key.length === 0 || canAny(authority, key);
}
