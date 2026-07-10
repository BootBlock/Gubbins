/**
 * useMilestonesStore — device-local record of one-time celebratory milestones (visual-flair F4).
 *
 * Some milestone bursts must fire exactly once *ever* on a device — the very first item added is
 * a first-run moment, not something to replay every time the inventory happens to empty and refill.
 * This tiny store persists which of those one-shot milestones have already been celebrated to
 * localStorage under `gubbins:milestones`, so a reload (or a delete-everything-then-re-add) never
 * re-triggers them. It is per-device, never synced — the same posture as theme / modules / layout —
 * and needs no database schema or migration.
 *
 * Repeatable milestones (e.g. completing a stock-take, which deserves the celebration each time)
 * are guarded at their call site and are deliberately *not* recorded here.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MilestonesStore {
  /** Whether the "first item ever added" burst has already played on this device. */
  readonly firstItemCelebrated: boolean;
  /** Mark the first-item milestone as celebrated (idempotent). */
  celebrateFirstItem: () => void;
}

export const useMilestonesStore = create<MilestonesStore>()(
  persist(
    (set) => ({
      firstItemCelebrated: false,
      celebrateFirstItem: () => set({ firstItemCelebrated: true }),
    }),
    { name: 'gubbins:milestones' },
  ),
);
