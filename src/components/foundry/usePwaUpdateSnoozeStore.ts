/**
 * usePwaUpdateSnoozeStore — Tier-2 store for how the user has dismissed the PWA update prompt
 * (spec §2 installable/offline-first PWA): a short "remind me later" snooze *and* a per-version
 * "skip this version" (issue #74).
 *
 * The "A new version is ready" banner is non-blocking, but a user who isn't ready to reload
 * shouldn't have to keep dismissing it. This small, domain-specific Zustand store (no god store)
 * records both dismissals in localStorage — device-local (mirroring the saved-searches store), so
 * no DB migration and nothing synced.
 *
 * - **snooze** records a deadline that persists across reloads, so the prompt stays hidden for the
 *   full ~8h window; a genuinely new waiting worker that installs while the page is open
 *   re-surfaces it early (the consumer clears the snooze via {@link surface}), so a real update is
 *   never lost.
 * - **skip** records a specific version the user has chosen to sit out. It has no expiry: the
 *   consumer keeps the prompt hidden while the deployed version is that one (or older), and shows
 *   it again the moment a *newer* version appears — so skipping one release never hides the next.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';

/** Default snooze window — roughly a working day's "remind me later" (~8h). */
export const DEFAULT_SNOOZE_MS = 8 * 60 * 60 * 1000;

interface PwaUpdateSnoozeStore {
  /** Epoch ms until which the prompt stays hidden; 0 = not snoozed. */
  readonly snoozedUntil: number;
  /** The app version the user chose to skip, or `null` if none is being skipped. */
  readonly skippedVersion: string | null;
  /** Hide the prompt for `durationMs` (default {@link DEFAULT_SNOOZE_MS}). */
  snooze: (durationMs?: number) => void;
  /** Sit out a specific deploy: hide the prompt until a version newer than `version` appears. */
  skip: (version: string) => void;
  /** Clear any active snooze so the prompt can re-surface immediately (does not clear a skip). */
  surface: () => void;
}

export const usePwaUpdateSnoozeStore = create<PwaUpdateSnoozeStore>()(
  persist(
    (set) => ({
      snoozedUntil: 0,
      skippedVersion: null,
      snooze: (durationMs = DEFAULT_SNOOZE_MS) => set({ snoozedUntil: Date.now() + durationMs }),
      skip: (version: string) => set({ skippedVersion: version }),
      surface: () => set({ snoozedUntil: 0 }),
    }),
    {
      name: 'gubbins:pwa-update-snooze',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
    },
  ),
);
