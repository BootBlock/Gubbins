/**
 * Who is signed in on this device, and what they may do (issue #79, plan §3).
 *
 * Persisted **per device**, not synced: signing in on the workshop tablet says nothing about
 * the phone, and a synced session would sign a second device in silently.
 *
 * Two fields, with a firm line between them:
 *
 * - **`session`** is persisted, and holds only an id and a display name. Never a role, its
 *   grants, or a password hash — a device can edit its own localStorage, so anything stored
 *   here is something the device can award itself.
 * - **`authority` / `actorId`** are **derived and in-memory only**, recomputed from the
 *   database by `authority-refresh.ts`. `partialize` keeps them out of storage; that is not a
 *   tidiness measure but the reason the previous point holds.
 *
 * The store deliberately imports nothing from `src/db`: the repository layer reads
 * `authority` and `actorId` from here, so a dependency in that direction would be a cycle.
 * Refreshing lives in `features/users/authority-refresh.ts`, which may import both.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';
import { normaliseSession, type Session } from '@/features/users/session';
import { UNRESTRICTED_AUTHORITY, type Authority } from '@/features/users/permissions';
import { ADMIN_USER_ID } from '@/db/repositories/constants';

interface SessionStore {
  readonly session: Session | null;
  /**
   * What the current session may do. Defaults to unrestricted — the state Gubbins ships in,
   * where the users module is off and every action is permitted (plan §3).
   */
  readonly authority: Authority;
  /** The user every write is attributed to. Admin while the module is off, as it always was. */
  readonly actorId: string;
  signIn: (session: Session) => void;
  signOut: () => void;
  /** Replace the derived pair. Called only by `authority-refresh.ts`. */
  setResolved: (authority: Authority, actorId: string) => void;
}

const DERIVED_DEFAULTS = { authority: UNRESTRICTED_AUTHORITY, actorId: ADMIN_USER_ID } as const;

export const useSessionStore = create<SessionStore>()(
  persist(
    (set) => ({
      session: null,
      ...DERIVED_DEFAULTS,
      signIn: (session) => set({ session }),
      // Signing out returns the derived pair to its defaults rather than leaving the previous
      // user's authority resident: a refresh is asynchronous, and the gap between the two must
      // not be a window in which the app still answers as whoever just left.
      signOut: () => set({ session: null, ...DERIVED_DEFAULTS }),
      setResolved: (authority, actorId) => set({ authority, actorId }),
    }),
    {
      name: 'gubbins:session',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      // The pass-through `migrate` ships with it deliberately: zustand discards persisted state
      // when a declared version has no `migrate` (see `adoptUnversioned`).
      version: 1,
      migrate: adoptUnversioned,
      // Only the session is written to storage — see the note above on why the derived pair
      // must never be.
      partialize: (state) => ({ session: state.session }),
      merge: (persisted, current) => ({
        ...current,
        session: normaliseSession((persisted as { session?: unknown } | null | undefined)?.session),
      }),
    },
  ),
);
