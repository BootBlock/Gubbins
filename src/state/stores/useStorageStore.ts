/**
 * useStorageStore — Tier-2 global storage telemetry (spec §2.1, §7.6.1).
 *
 * Holds the live OPFS persistence + quota state and the derived degradation tier,
 * polling `navigator.storage.estimate()` every 5 minutes while monitoring is
 * active. This is runtime telemetry, not a user preference, so it is intentionally
 * NOT persisted to localStorage.
 */
import { create } from 'zustand';
import {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
  type StorageEstimateResult,
} from '@/features/storage/storage-api';
import { classifyStorageTier, type StorageTier } from '@/features/storage/tiers';

/** Spec §7.6.1: poll storage every 5 minutes. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface StorageStore {
  readonly persisted: boolean;
  readonly estimate: StorageEstimateResult | null;
  readonly ratio: number;
  readonly tier: StorageTier;
  /** Whether the user has dismissed the (warning-tier only) banner. */
  readonly warningDismissed: boolean;

  /** Re-read persistence + quota and recompute the tier. */
  refresh: () => Promise<void>;
  /** Prompt the browser for persistent storage; returns the resulting state. */
  requestPersistence: () => Promise<boolean>;
  /** Dismiss the warning-tier banner (critical/locked remain persistent). */
  dismissWarning: () => void;
  /** Begin periodic polling (idempotent). */
  startMonitoring: () => void;
  /** Stop periodic polling. */
  stopMonitoring: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useStorageStore = create<StorageStore>()((set, get) => ({
  persisted: false,
  estimate: null,
  ratio: 0,
  tier: 'ok',
  warningDismissed: false,

  refresh: async () => {
    const [estimate, persisted] = await Promise.all([estimateStorage(), isStoragePersisted()]);
    const tier = classifyStorageTier(estimate.ratio);
    set((state) => {
      const base = { estimate, persisted, ratio: estimate.ratio, tier };
      // Recovered to OK, or the tier changed: clear any prior dismissal so a
      // worsened state re-surfaces its banner.
      if (tier === 'ok' || tier !== state.tier) {
        return { ...base, warningDismissed: false };
      }
      return base;
    });
  },

  requestPersistence: async () => {
    const granted = await requestPersistentStorage();
    set({ persisted: granted });
    return granted;
  },

  dismissWarning: () => set({ warningDismissed: true }),

  startMonitoring: () => {
    if (pollTimer !== null) return;
    void get().refresh();
    pollTimer = setInterval(() => void get().refresh(), POLL_INTERVAL_MS);
  },

  stopMonitoring: () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));
