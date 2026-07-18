/**
 * useLabStore — device-local state for the hidden lab screen (`/lab`).
 *
 * Holds three kinds of override, all persisted to localStorage under `gubbins:lab`:
 *  - **A date override** — the calendar date the app should *believe* it is, which is what makes
 *    every date-gated judgement (dead stock, expiry, service due, overdue bookings, the seasonal
 *    garnish) reachable without waiting. Applied via {@link import('@/lib/clock')}, which shifts
 *    evaluation only — never a timestamp that gets written down.
 *  - **Occasion modes** — per seasonal occasion, whether its background garnish is left to the
 *    calendar (`auto`, the default), forced on, or suppressed.
 *  - **Boolean flags** — the ids in {@link LAB_FLAGS}, all default-off.
 *
 * Like theme and modules state this is per-device and never synced: it describes how *this*
 * browser is being driven, not anything about the user's inventory. The maps store only explicit
 * choices, so an id never touched — including one added in a later release — reads as its default
 * without any migration.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';
import type { LabFlagId } from '@/features/lab/lab-flags';
import type { OccasionId, OccasionMode, OccasionOverrides } from '@/components/background/seasonal';

interface LabStore {
  /** `yyyy-mm-dd` the app should treat as today, or `null` to use the real date. */
  readonly dateOverride: string | null;
  /** Per-occasion garnish gating; a missing key means `auto` (the calendar decides). */
  readonly occasionModes: OccasionOverrides;
  /** Boolean flag overrides; a missing key means off. */
  readonly flags: Readonly<Partial<Record<LabFlagId, boolean>>>;
  setDateOverride: (isoDate: string | null) => void;
  setOccasionMode: (id: OccasionId, mode: OccasionMode) => void;
  setFlag: (id: LabFlagId, on: boolean) => void;
  /** Clear every override back to the shipped behaviour. */
  resetLab: () => void;
}

const EMPTY: Pick<LabStore, 'dateOverride' | 'occasionModes' | 'flags'> = {
  dateOverride: null,
  occasionModes: {},
  flags: {},
};

export const useLabStore = create<LabStore>()(
  persist(
    (set) => ({
      ...EMPTY,
      // An empty string from a cleared date input means "no override", not an unparseable date.
      setDateOverride: (isoDate) => set({ dateOverride: isoDate ? isoDate : null }),
      setOccasionMode: (id, mode) =>
        set((state) => ({ occasionModes: { ...state.occasionModes, [id]: mode } })),
      setFlag: (id, on) => set((state) => ({ flags: { ...state.flags, [id]: on } })),
      resetLab: () => set({ ...EMPTY }),
    }),
    {
      name: 'gubbins:lab',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
    },
  ),
);

/**
 * Read one boolean lab flag (default off). A hook, so the caller re-renders when it changes.
 *
 * For a non-React read — a repository, an engine, anything outside the component tree — use
 * {@link labFlag} instead; it reads the same store without subscribing.
 */
export function useLabFlag(id: LabFlagId): boolean {
  return useLabStore((state) => state.flags[id] ?? false);
}

/**
 * Non-reactive read of a lab flag, for code that runs outside React (sync reconciliation, the
 * scanner's media plumbing). Callers that need to re-render on a change must use {@link useLabFlag}.
 */
export function labFlag(id: LabFlagId): boolean {
  return useLabStore.getState().flags[id] ?? false;
}
