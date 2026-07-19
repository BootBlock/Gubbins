/**
 * The signed-in session (issue #79, plan §3) — pure reconciliation, no store.
 *
 * Kept separate from `useSessionStore` so the "is this persisted blob trustworthy?" logic can
 * be unit-tested without rehydrating a Zustand store, following the `audit-session` precedent.
 * `JSON.parse` output is attacker-adjacent input in the sense that matters here: it is
 * whatever was last written to this device's localStorage, by any version of Gubbins.
 */
import { isPlainObject, normaliseInteger } from '@/lib/persisted-state';

/**
 * Who is signed in on this device.
 *
 * Only the **id** is authoritative. `displayName` is carried purely so the chrome can render
 * a name before the database has answered; every permission decision re-reads the user and
 * their role from the database, so a stale or tampered name here changes nothing but a label.
 * Storing the role or its grants would be the dangerous version of this — a device that edited
 * its own localStorage would grant itself permissions — so the session deliberately holds
 * neither.
 */
export interface Session {
  readonly userId: string;
  readonly displayName: string;
  readonly signedInAt: number;
}

/** A non-empty string, or `null`. */
function normaliseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Reconcile a persisted session, returning `null` for anything that is not a complete,
 * plausible session. Partial recovery is deliberately not attempted: a session missing its
 * user id is not a session, and inventing one would sign somebody in as nobody.
 */
export function normaliseSession(value: unknown): Session | null {
  if (!isPlainObject(value)) return null;

  const userId = normaliseString(value.userId);
  if (userId === null) return null;

  const displayName = normaliseString(value.displayName);
  if (displayName === null) return null;

  return { userId, displayName, signedInAt: normaliseInteger(value.signedInAt, 0, { min: 0 }) };
}
