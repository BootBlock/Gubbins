/**
 * useAuditSessionStore — Tier-3 resumable state for a guided stock-take / audit-day
 * session (spec §4.4, §2.1).
 *
 * A stock-take walks *many* locations in turn, so — unlike the single-location count,
 * whose transient inputs live in the ephemeral {@link CycleCountProvider} — the walk's
 * cross-location progress must survive a reload so a half-done audit can be resumed. It
 * is therefore persisted to `localStorage` via Zustand `persist`, mirroring
 * `useLayoutStore` / `useLocationExpansionStore`. This store deliberately tracks only the
 * scope, the current position and the per-location outcome (never the individual counts,
 * which stay in the per-location `CycleCountProvider`); all of the progress/summary maths
 * is delegated to the pure, unit-tested {@link module:audit-session} seam.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  startAudit,
  markLocation,
  advance,
  resumeAt,
  progress,
  normaliseAuditSession,
  type AuditLocationStatus,
  type AuditScopeLocation,
  type AuditSessionState,
} from './audit-session';

interface AuditSessionStore {
  /** The active session, or null when no stock-take is in progress. */
  readonly session: AuditSessionState | null;

  /** Begin a new walk over an ordered scope (replaces any prior session). */
  start: (scope: readonly AuditScopeLocation[]) => void;

  /**
   * Record the current location's outcome and advance to the next pending location.
   * `totals` carries the variance/adjustment counts for the summary roll-up.
   */
  recordCurrent: (
    status: AuditLocationStatus,
    totals?: { variancesFound?: number; adjustmentsMade?: number },
  ) => void;

  /** Skip the current location (records `skipped`) and advance. */
  skipCurrent: () => void;

  /** On reopen, jump the walk to the first location still needing work. */
  resume: () => void;

  /** Abandon the session entirely (clears persisted state). */
  abandon: () => void;
}

export const useAuditSessionStore = create<AuditSessionStore>()(
  persist(
    (set) => ({
      session: null,

      start: (scope) => set({ session: startAudit(scope) }),

      recordCurrent: (status, totals) =>
        set((state) => {
          if (!state.session) return state;
          const current = progress(state.session).current;
          if (!current) return state;
          const recorded = markLocation(state.session, current.id, status, totals);
          return { session: advance(recorded) };
        }),

      skipCurrent: () =>
        set((state) => {
          if (!state.session) return state;
          const current = progress(state.session).current;
          if (!current) return state;
          const recorded = markLocation(state.session, current.id, 'skipped');
          return { session: advance(recorded) };
        }),

      resume: () => set((state) => (state.session ? { session: resumeAt(state.session) } : state)),

      abandon: () => set({ session: null }),
    }),
    {
      name: 'gubbins:audit-session',
      // The session is rehydrated from untyped JSON but every reducer here indexes `scope` by
      // `currentIndex`, so reconcile it back to a valid shape (or "no session") on read rather
      // than letting a truncated or stale write reach `progress`.
      merge: (persisted, current) => ({
        ...current,
        session: normaliseAuditSession((persisted as { session?: unknown } | null | undefined)?.session),
      }),
    },
  ),
);
