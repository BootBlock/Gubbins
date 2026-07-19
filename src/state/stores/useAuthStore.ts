/**
 * useAuthStore — Tier-2 cloud-handshake state (spec §2.1 Tier 2, §2 Initial Handshake).
 *
 * The third of the §2.1 example stores. It persists *which* provider the user has
 * connected (and, for a real cloud provider, would hold the simple API key) so the
 * app remembers it is configured across sessions. The *live* provider instance — and
 * any non-serialisable handles like a File System Access directory handle — lives in
 * the in-memory runtime registry (`features/sync/runtime`), not here, so a reload
 * shows "connected" and offers to reconnect rather than silently losing the choice.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';

export interface AuthStore {
  /** Connected provider id (`'memory'` | `'file-system'`), or null when never set up. */
  readonly providerId: string | null;
  /** Human-readable provider label for the UI. */
  readonly providerLabel: string | null;
  /** When the handshake last completed (UNIX-ms). */
  readonly connectedAt: number | null;
  /** Last successful sync time (UNIX-ms), shown in the UI. */
  readonly lastSyncedAt: number | null;
  setProvider: (providerId: string, providerLabel: string) => void;
  markSynced: (at?: number) => void;
  disconnect: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      providerId: null,
      providerLabel: null,
      connectedAt: null,
      lastSyncedAt: null,
      // Connecting a *different* remote clears `lastSyncedAt`: it records when this device last
      // synced through the connection it currently holds, so carrying it across to a new folder
      // or account would claim a sync that never happened with that remote. Issue #196 reads it
      // to tell "the shared copy has gone missing" apart from "this remote is simply new".
      setProvider: (providerId, providerLabel) =>
        set((state) => ({
          providerId,
          providerLabel,
          connectedAt: Date.now(),
          lastSyncedAt:
            state.providerId === providerId && state.providerLabel === providerLabel
              ? state.lastSyncedAt
              : null,
        })),
      markSynced: (at = Date.now()) => set({ lastSyncedAt: at }),
      disconnect: () => set({ providerId: null, providerLabel: null, connectedAt: null, lastSyncedAt: null }),
    }),
    {
      name: 'gubbins:auth',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
    },
  ),
);
