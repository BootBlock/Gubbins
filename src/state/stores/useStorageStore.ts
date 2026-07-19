/**
 * useStorageStore — Tier-2 global storage telemetry (spec §2.1, §7.6.1).
 *
 * Holds the live OPFS persistence + quota state and the derived degradation tier, polling
 * `navigator.storage.estimate()` while monitoring is active. This is runtime telemetry, not a
 * user preference, so it is intentionally NOT persisted to localStorage.
 *
 * The poll interval **tightens as the tier worsens** (issue #200). A flat five minutes is fine
 * while there is headroom, but it is far too coarse near the ceiling: a bulk import or a batch
 * scan can consume the remaining quota well inside one window, and the Hard Stop would keep
 * reading `ok` for the rest of it. Near the ceiling the measurement is both cheaper to justify
 * and the only thing standing between the user and an `SQLITE_FULL`.
 */
import { create } from 'zustand';
import {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
  type StorageEstimateResult,
} from '@/features/storage/storage-api';
import { classifyStorageTier, isWriteSuspended, type StorageTier } from '@/features/storage/tiers';
import { writeSuspendedError, type StorageWriteGate } from '@/features/storage/write-gate';
import { useLabFlag } from './useLabStore';

/**
 * How often to re-measure, by the tier the last measurement produced. Spec §7.6.1's five
 * minutes is the `ok` case; the tighter tiers are issue #200 (see the module note above).
 */
export const POLL_INTERVAL_MS: Readonly<Record<StorageTier, number>> = {
  ok: 5 * 60 * 1000,
  warning: 60 * 1000,
  critical: 15 * 1000,
  locked: 15 * 1000,
};

/**
 * How stale a measurement may be before a *bulk* write re-measures rather than trusting it
 * (issue #200). Short enough that the reading describes the disk this write is about to land
 * on, long enough that a burst of bulk operations does not re-estimate on every one.
 */
export const WRITE_GATE_MAX_AGE_MS = 10 * 1000;

interface StorageStore {
  readonly persisted: boolean;
  readonly estimate: StorageEstimateResult | null;
  readonly ratio: number;
  readonly tier: StorageTier;
  /** `Date.now()` of the last completed measurement; 0 before the first one. */
  readonly lastCheckedAt: number;
  /** Whether the user has dismissed the (warning-tier only) banner. */
  readonly warningDismissed: boolean;

  /** Re-read persistence + quota and recompute the tier. */
  refresh: () => Promise<void>;
  /** {@link refresh}, but only when the last measurement is older than `maxAgeMs`. */
  refreshIfStale: (maxAgeMs: number) => Promise<void>;
  /** Prompt the browser for persistent storage; returns the resulting state. */
  requestPersistence: () => Promise<boolean>;
  /** Dismiss the warning-tier banner (critical/locked remain persistent). */
  dismissWarning: () => void;
  /** Begin periodic polling (idempotent). */
  startMonitoring: () => void;
  /** Stop periodic polling. */
  stopMonitoring: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let monitoring = false;
/** The in-flight `refresh()`, so concurrent callers share one `estimate()` rather than racing. */
let inFlight: Promise<void> | null = null;

export const useStorageStore = create<StorageStore>()((set, get) => ({
  persisted: false,
  estimate: null,
  ratio: 0,
  tier: 'ok',
  lastCheckedAt: 0,
  warningDismissed: false,

  refresh: async () => {
    // Coalesce: a poll firing while a bulk write's gate is already measuring must not issue a
    // second `estimate()`, and both callers want the same answer anyway.
    if (inFlight) return inFlight;
    const run = (async () => {
      const [estimate, persisted] = await Promise.all([estimateStorage(), isStoragePersisted()]);
      const tier = classifyStorageTier(estimate.ratio);
      set((state) => {
        const base = { estimate, persisted, ratio: estimate.ratio, tier, lastCheckedAt: Date.now() };
        // Recovered to OK, or the tier changed: clear any prior dismissal so a
        // worsened state re-surfaces its banner.
        if (tier === 'ok' || tier !== state.tier) {
          return { ...base, warningDismissed: false };
        }
        return base;
      });
    })();
    inFlight = run;
    // Release the slot however it settles — and only if it is still ours. Clearing it from a
    // `finally` *inside* the promise would run before this assignment when the body throws
    // synchronously, latching a rejected promise that every later refresh would return.
    const release = () => {
      if (inFlight === run) inFlight = null;
    };
    run.then(release, release);
    return run;
  },

  refreshIfStale: async (maxAgeMs) => {
    const { lastCheckedAt } = get();
    if (lastCheckedAt !== 0 && Date.now() - lastCheckedAt < maxAgeMs) return;
    await get().refresh();
  },

  requestPersistence: async () => {
    const granted = await requestPersistentStorage();
    set({ persisted: granted });
    return granted;
  },

  dismissWarning: () => set({ warningDismissed: true }),

  startMonitoring: () => {
    if (monitoring) return;
    monitoring = true;
    // Self-rescheduling rather than a fixed `setInterval`, so each measurement picks the
    // cadence its own outcome warrants.
    const tick = async () => {
      try {
        await get().refresh();
      } catch {
        // A failed measurement must never end the loop — telemetry is precisely what is needed
        // when things are going wrong. Keep the last known tier and try again next time.
      }
      if (!monitoring) return;
      pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS[get().tier]);
    };
    void tick();
  },

  stopMonitoring: () => {
    monitoring = false;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
}));

/**
 * The production {@link StorageWriteGate} (issue #200): re-measure if the reading is stale,
 * then refuse the write if that leaves us at the locked tier.
 *
 * The re-measurement is the point. Repository writes are individually small enough that the
 * poll keeps up with them, but the paths that install this gate are the bulk ones — a sync
 * merge, a snapshot restore, a catalog import — each capable of consuming the remaining quota
 * on its own. Deciding those against a reading taken minutes ago is deciding them against a
 * disk that no longer exists.
 */
export const storageWriteGate: StorageWriteGate = async () => {
  await useStorageStore.getState().refreshIfStale(WRITE_GATE_MAX_AGE_MS);
  if (isWriteSuspended(useStorageStore.getState().tier)) throw writeSuspendedError();
};

/**
 * Reactive read of whether storage presents as persisted. Overridden to `false` while the lab's
 * `storage-persistence-denied` flag is on, so the "your data may be cleared by the browser"
 * banner and dashboard widget can be exercised even where the browser has genuinely granted
 * persistence — the real `persisted` state (and the browser's grant) is left untouched.
 */
export function useStoragePersisted(): boolean {
  const persisted = useStorageStore((state) => state.persisted);
  const denied = useLabFlag('storage-persistence-denied');
  return persisted && !denied;
}
