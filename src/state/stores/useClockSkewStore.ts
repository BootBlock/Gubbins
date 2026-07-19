/**
 * useClockSkewStore — the last measured device-clock error, persisted per device (issue #326).
 *
 * The correction has to survive a reload for the same reason the lab date override does: the
 * date-driven queries (expiring soon, due for service, dead stock) evaluate as the app mounts,
 * long before a network round-trip could return a fresh measurement. Persisting the last known
 * skew lets boot apply a correction immediately and refine it when the measurement lands, so a
 * device with a wrong clock is never briefly judged on it.
 *
 * Device-local and never synced or backed up: it describes *this* machine's clock, and restoring
 * one device's skew onto another would apply a correction for an error that device doesn't have.
 *
 * `measuredAt` is stamped from the **raw** system clock rather than `nowMs()`. It exists to answer
 * "how stale is this correction?", which is a question about elapsed local time; deriving it from
 * the very clock being corrected would make a stale reading look fresh.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned, isPlainObject, normaliseInteger } from '@/lib/persisted-state';
import { quantiseSkew } from '@/features/clock-skew/skew';

interface ClockSkewStore {
  /** Milliseconds to add to `Date.now()` to reach true time; 0 when trusted or unmeasured. */
  readonly skewMs: number;
  /** Raw-clock epoch-ms of the last successful measurement; 0 when never measured. */
  readonly measuredAt: number;
  recordSkew: (skewMs: number, measuredAt: number) => void;
  clearSkew: () => void;
}

const EMPTY: Pick<ClockSkewStore, 'skewMs' | 'measuredAt'> = { skewMs: 0, measuredAt: 0 };

export const useClockSkewStore = create<ClockSkewStore>()(
  persist(
    (set) => ({
      ...EMPTY,
      recordSkew: (skewMs, measuredAt) => set({ skewMs, measuredAt }),
      clearSkew: () => set({ ...EMPTY }),
    }),
    {
      name: 'gubbins:clock-skew',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      // The pass-through `migrate` ships with it deliberately: zustand discards persisted state
      // when a declared version has no `migrate` (see `adoptUnversioned`).
      version: 1,
      migrate: adoptUnversioned,
      // Reconcile on read: `persist` hands back whatever `JSON.parse` returned, and a corrupt or
      // hand-edited value here would be added to *every* date judgement in the app. Running it
      // back through `quantiseSkew` — the same rule the measurement path uses — means a stored
      // value can never apply a correction a fresh reading would have refused. Note it *rejects*
      // an out-of-range value rather than clamping: clamping would turn a nonsense number into a
      // plausible-looking year-long shift instead of falling back to the system clock.
      merge: (persisted, current) => {
        if (!isPlainObject(persisted)) return current;
        return {
          ...current,
          skewMs: quantiseSkew(normaliseInteger(persisted.skewMs, 0)),
          measuredAt: normaliseInteger(persisted.measuredAt, 0, { min: 0 }),
        };
      },
    },
  ),
);
