/**
 * useLabStore — device-local state for the hidden lab screen (`/lab`).
 *
 * Holds two kinds of override, both persisted to localStorage under `gubbins:lab`:
 *  - **Occasion modes** — per seasonal occasion, whether its background garnish is left to the
 *    calendar (`auto`, the default), forced on, or suppressed. This is what makes December's
 *    presents testable in July.
 *  - **Boolean flags** — the ids in {@link LAB_FLAGS}, all default-off.
 *
 * Like theme and modules state this is per-device and never synced: it describes how *this*
 * browser is being driven, not anything about the user's inventory. Both maps store only
 * explicit choices, so an id that has never been touched — including one added in a later
 * release — reads as its default without any migration.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LabFlagId } from '@/features/lab/lab-flags';
import type { OccasionId, OccasionMode, OccasionOverrides } from '@/components/background/seasonal';

interface LabStore {
  /** Per-occasion garnish gating; a missing key means `auto` (the calendar decides). */
  readonly occasionModes: OccasionOverrides;
  /** Boolean flag overrides; a missing key means off. */
  readonly flags: Readonly<Partial<Record<LabFlagId, boolean>>>;
  setOccasionMode: (id: OccasionId, mode: OccasionMode) => void;
  setFlag: (id: LabFlagId, on: boolean) => void;
  /** Clear every override back to the shipped behaviour. */
  resetLab: () => void;
}

export const useLabStore = create<LabStore>()(
  persist(
    (set) => ({
      occasionModes: {},
      flags: {},
      setOccasionMode: (id, mode) =>
        set((state) => ({ occasionModes: { ...state.occasionModes, [id]: mode } })),
      setFlag: (id, on) => set((state) => ({ flags: { ...state.flags, [id]: on } })),
      resetLab: () => set({ occasionModes: {}, flags: {} }),
    }),
    { name: 'gubbins:lab' },
  ),
);

/** Read one boolean lab flag (default off). A hook, so the caller re-renders when it changes. */
export function useLabFlag(id: LabFlagId): boolean {
  return useLabStore((state) => state.flags[id] ?? false);
}
