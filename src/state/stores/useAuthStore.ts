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
      setProvider: (providerId, providerLabel) =>
        set({ providerId, providerLabel, connectedAt: Date.now() }),
      markSynced: (at = Date.now()) => set({ lastSyncedAt: at }),
      disconnect: () =>
        set({ providerId: null, providerLabel: null, connectedAt: null, lastSyncedAt: null }),
    }),
    { name: 'gubbins:auth' },
  ),
);
