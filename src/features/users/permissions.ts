/**
 * The permission engine (issue #79, plan §2.3, §3).
 *
 * A pure, side-effect-free seam: it answers "may this principal do this?" and nothing else.
 * It reads no store, touches no database and imports no React, because two very different
 * callers depend on it — the app's repository guards, and the Bridge, which resolves an API
 * token to a user and gates every route with the same rules (plan §1.3). Node's strip-only
 * loader means it must also avoid `enum`, `namespace` and parameter properties.
 *
 * The shape is deliberately two-step: {@link resolveAuthority} turns "who is signed in, and
 * is the module even on?" into a flat {@link Authority}, and {@link can} answers questions
 * against it. That split is what lets an authority be resolved once per request (Bridge) or
 * once per render (app) and then consulted cheaply, and it keeps every "module off means
 * unrestricted" rule in one function instead of scattered through call sites.
 */
import type { UserKind } from '@/db/repositories/constants';
import {
  GRANT_ALL,
  isPermissionGrant,
  splitGrant,
  type PermissionKey,
  type PermissionSubject,
} from './permission-registry';

/**
 * The parts of a user the engine needs. Deliberately narrower than the `User` row so a
 * caller can resolve an authority without loading (or being able to leak) a password hash.
 */
export interface AuthorityPrincipal {
  readonly id: string;
  readonly kind: UserKind;
  readonly isEnabled: boolean;
}

/**
 * Why an authority grants nothing at all. The distinction exists purely to be *shown*: all
 * four deny identically, but "you have no role" and "your role grants nothing" call for
 * different advice, and telling an operator to assign a role they already assigned is worse
 * than saying nothing.
 */
export type AuthorityDenial = 'signed-out' | 'disabled' | 'no-role' | 'no-permissions';

/**
 * A resolved answer to "what may this session do?".
 *
 * - `unrestricted` — everything, unconditionally. Both single-user mode (the module is off,
 *   so Gubbins behaves exactly as it always has) and the built-in System/Admin principals
 *   land here. There is deliberately no way to express "unrestricted except…": Admin's
 *   permissions are not editable (plan §2.2), and an escape hatch here would be the one
 *   route to locking every account out of a local database.
 * - `denied` — nothing, with the reason.
 * - `granted` — whatever the role's grants say.
 */
export type Authority =
  | { readonly mode: 'unrestricted' }
  | { readonly mode: 'denied'; readonly reason: AuthorityDenial }
  | { readonly mode: 'granted'; readonly grants: ReadonlySet<string> };

/** The shared `unrestricted` authority — single-user mode's answer, and the default. */
export const UNRESTRICTED_AUTHORITY: Authority = { mode: 'unrestricted' };

/** What {@link resolveAuthority} needs to decide. */
export interface AuthorityInput {
  /**
   * Whether the users module is switched on. With it **off** every caller is unrestricted
   * and acts as Admin — the plan's single-user mode (§3), and the state Gubbins ships in.
   */
  readonly moduleEnabled: boolean;
  /** The signed-in principal, or `undefined` when nobody is signed in. */
  readonly user?: AuthorityPrincipal | undefined;
  /**
   * The grants of the user's role, straight from `roles.permissions`. Passed as raw strings
   * rather than a validated union: a peer on a newer Gubbins may sync a role holding a key
   * this build has never heard of, and such a grant must round-trip untouched rather than
   * being dropped. It simply never matches anything here.
   */
  readonly grants?: readonly string[] | undefined;
}

/**
 * Turn a session into an {@link Authority}.
 *
 * Order matters. `kind` is checked before `isEnabled` because the seeded **System** user is
 * stored disabled — it can never sign in, but it is the actor the app itself writes as, so
 * it must still be unrestricted. Reversing the two would leave maintenance and sync
 * reconciliation unable to write.
 */
export function resolveAuthority(input: AuthorityInput): Authority {
  if (!input.moduleEnabled) return UNRESTRICTED_AUTHORITY;

  const user = input.user;
  if (!user) return { mode: 'denied', reason: 'signed-out' };
  if (user.kind === 'system' || user.kind === 'admin') return UNRESTRICTED_AUTHORITY;
  if (!user.isEnabled) return { mode: 'denied', reason: 'disabled' };

  const grants = input.grants;
  if (!grants) return { mode: 'denied', reason: 'no-role' };
  // A role that deliberately grants nothing (a "Suspended" role) is not the same state as an
  // account with no role assigned, even though both permit nothing.
  if (grants.length === 0) return { mode: 'denied', reason: 'no-permissions' };
  return { mode: 'granted', grants: new Set(grants) };
}

/**
 * Whether `authority` permits `key`.
 *
 * A granted authority matches on three widening forms — the exact key, its subject wildcard
 * (`items:*`) and the global wildcard (`*`) — so a role defined as "everything" keeps
 * meaning everything after a later release adds a key it has never seen.
 */
export function can(authority: Authority, key: PermissionKey): boolean {
  if (authority.mode === 'unrestricted') return true;
  if (authority.mode === 'denied') return false;

  const grants = authority.grants;
  if (grants.has(GRANT_ALL) || grants.has(key)) return true;
  const [subject] = splitGrant(key);
  return grants.has(`${subject}:*`);
}

/** Whether `authority` permits **every** key in `keys`. An empty list is trivially true. */
export function canAll(authority: Authority, keys: readonly PermissionKey[]): boolean {
  return keys.every((key) => can(authority, key));
}

/** Whether `authority` permits **any** key in `keys`. An empty list is trivially false. */
export function canAny(authority: Authority, keys: readonly PermissionKey[]): boolean {
  return keys.some((key) => can(authority, key));
}

/**
 * Whether `authority` permits anything at all on `subject` — the question a nav entry or a
 * screen guard asks, where "may they see this section?" is broader than any single action.
 */
export function canTouchSubject(authority: Authority, subject: PermissionSubject): boolean {
  if (authority.mode === 'unrestricted') return true;
  if (authority.mode === 'denied') return false;
  if (authority.grants.has(GRANT_ALL) || authority.grants.has(`${subject}:*`)) return true;
  for (const grant of authority.grants) {
    if (splitGrant(grant)[0] === subject) return true;
  }
  return false;
}

/**
 * Normalise grants for storage: trimmed, de-duplicated, and in registry order so two roles
 * with the same permissions compare equal as JSON rather than differing by insertion order.
 *
 * Grants this build does not recognise are **kept**, sorted after the known ones, for the
 * forward-compatibility reason described on {@link AuthorityInput.grants}. Editing a role on
 * an older device must not silently strip the permissions a newer one gave it.
 */
export function normaliseGrants(grants: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const raw of grants) {
    const grant = raw.trim();
    if (grant.length > 0) seen.add(grant);
  }
  const known: string[] = [];
  const unknown: string[] = [];
  for (const grant of seen) {
    (isPermissionGrant(grant) ? known : unknown).push(grant);
  }
  known.sort();
  unknown.sort();
  return [...known, ...unknown];
}
