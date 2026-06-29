/**
 * usePwaUpdateSnoozeStore — Tier-2 store for the "remind me later" snooze on the PWA
 * update prompt (spec §2 installable/offline-first PWA).
 *
 * The "A new version is ready" banner is non-blocking, but a user who isn't ready to
 * reload shouldn't have to keep dismissing it. This small, domain-specific Zustand store
 * (no god store) records a snooze deadline in localStorage — device-local (mirroring the
 * saved-searches store), so no DB migration and nothing synced. The deadline persists across
 * reloads, so the prompt stays hidden for the full ~8h window; a genuinely new waiting worker
 * that installs while the page is open re-surfaces it early (the consumer clears the snooze
 * via {@link surface}), so a real update is never lost.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Default snooze window — roughly a working day's "remind me later" (~8h). */
export const DEFAULT_SNOOZE_MS = 8 * 60 * 60 * 1000;

interface PwaUpdateSnoozeStore {
  /** Epoch ms until which the prompt stays hidden; 0 = not snoozed. */
  readonly snoozedUntil: number;
  /** Hide the prompt for `durationMs` (default {@link DEFAULT_SNOOZE_MS}). */
  snooze: (durationMs?: number) => void;
  /** Clear any active snooze so the prompt can re-surface immediately. */
  surface: () => void;
}

export const usePwaUpdateSnoozeStore = create<PwaUpdateSnoozeStore>()(
  persist(
    (set) => ({
      snoozedUntil: 0,
      snooze: (durationMs = DEFAULT_SNOOZE_MS) =>
        set({ snoozedUntil: Date.now() + durationMs }),
      surface: () => set({ snoozedUntil: 0 }),
    }),
    { name: 'gubbins:pwa-update-snooze' },
  ),
);
