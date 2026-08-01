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
 *
 * The measurement is nonetheless only a *prediction*, and it can be wrong in the direction that
 * matters (issue #504). So the tier is no longer the measurement alone: a write that actually
 * failed for lack of space pins a floor under it — see {@link StorageStore.exhaustion} and
 * `features/storage/exhaustion` — and the observation outranks the estimate until something
 * disproves it.
 */
import { create } from 'zustand';
import {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
  type StorageEstimateResult,
} from '@/features/storage/storage-api';
import {
  classifyStorageTier,
  isWriteSuspended,
  worstStorageTier,
  type StorageTier,
} from '@/features/storage/tiers';
import { OBSERVED_EXHAUSTION_TIER } from '@/features/storage/exhaustion';
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

/**
 * How much free space must *reappear*, relative to the headroom that proved insufficient, before
 * an observed exhaustion is treated as stale (issue #504).
 *
 * A margin rather than a bare increase, so ordinary jitter in a quantised estimate cannot release
 * the Hard Stop on its own. It only has to be crossed by space freed **outside** Gubbins — the one
 * case the app cannot otherwise learn about, and one that frees far more than this — because space
 * freed *inside* Gubbins produces a successful write, which releases the latch by itself.
 */
export const EXHAUSTION_RECOVERY_MARGIN_BYTES = 1024 * 1024;

/**
 * A write that provably ran out of space, and what it takes to stop believing it (issue #504).
 *
 * Held rather than merely applied once, because the estimate that would otherwise "clear" the tier
 * on the next poll is exactly the reading that was wrong. It is released only by evidence of the
 * same kind: a write that lands, or headroom that measurably comes back.
 */
export interface ObservedStorageExhaustion {
  /**
   * The measurement counter as it stood when the failure was observed. Only a measurement *begun*
   * after that — a strictly greater sequence — describes the disk as it is now.
   *
   * A sequence rather than a timestamp because `Date.now()` cannot separate two events inside the
   * same millisecond, which is exactly the gap a failure and an already-running estimate fall into.
   */
  readonly afterMeasurement: number;
  /** True once a measurement begun after {@link afterMeasurement} has completed. */
  readonly measured: boolean;
  /**
   * Free bytes that measurement reported — the headroom that provably was not enough. `null` until
   * it lands, and where the browser reports no quota at all (in which case only a successful write
   * can release the latch).
   */
  readonly baselineAvailable: number | null;
}

interface StorageStore {
  readonly persisted: boolean;
  readonly estimate: StorageEstimateResult | null;
  readonly ratio: number;
  /**
   * The tier everything acts on: the worse of {@link measuredTier} and the floor an observed
   * out-of-space failure pins (issue #504).
   */
  readonly tier: StorageTier;
  /** The tier the last `navigator.storage.estimate()` alone implies. */
  readonly measuredTier: StorageTier;
  /** The live out-of-space observation, or `null` when nothing has failed for want of space. */
  readonly exhaustion: ObservedStorageExhaustion | null;
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
  /** Record that a write failed for lack of space, raising the tier to the Hard Stop. */
  reportExhaustion: () => void;
  /** Record that a write landed, releasing an observed exhaustion the estimate never would. */
  reportWriteSucceeded: () => void;
  /** Begin periodic polling (idempotent). */
  startMonitoring: () => void;
  /** Stop periodic polling. */
  stopMonitoring: () => void;
}

/** The tier to act on: the measurement, floored by any live out-of-space observation. */
function effectiveTier(measured: StorageTier, exhaustion: ObservedStorageExhaustion | null): StorageTier {
  return exhaustion ? worstStorageTier(measured, OBSERVED_EXHAUSTION_TIER) : measured;
}

/** Free bytes this estimate implies, or `null` where the browser reports no usable quota. */
function availableBytes(estimate: StorageEstimateResult): number | null {
  if (!estimate.supported || estimate.quota <= 0) return null;
  return Math.max(0, estimate.quota - estimate.usage);
}

/**
 * Fold a completed measurement into a live observation: take its baseline if it is the first one
 * since the failure, and release the observation once headroom has measurably returned.
 *
 * When the measurement *began* is what decides "since the failure": one already in flight when the
 * failure was reported describes the disk before it, and adopting its (larger) reading as the
 * baseline would pin a headroom figure that a genuinely recovered disk never has to beat.
 */
function settleExhaustion(
  current: ObservedStorageExhaustion | null,
  estimate: StorageEstimateResult,
  sequence: number,
): ObservedStorageExhaustion | null {
  if (!current) return null;
  if (sequence <= current.afterMeasurement) return current;
  const available = availableBytes(estimate);
  if (!current.measured) return { ...current, measured: true, baselineAvailable: available };
  // Space has come back — a cleanup here, or the device itself being freed up — so the failure no
  // longer describes the disk this app is writing to.
  const recovered =
    current.baselineAvailable !== null &&
    available !== null &&
    available - current.baselineAvailable > EXHAUSTION_RECOVERY_MARGIN_BYTES;
  return recovered ? null : current;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let monitoring = false;
/** The in-flight `refresh()`, so concurrent callers share one `estimate()` rather than racing. */
let inFlight: Promise<void> | null = null;
/**
 * Measurements issued so far. Stamped on each `estimate()` at the moment it is *issued*, so an
 * observed exhaustion can tell a reading taken after it from one that was already in flight —
 * something wall-clock milliseconds are too coarse to do (see {@link ObservedStorageExhaustion}).
 */
let measurementSequence = 0;
/**
 * The running poll's tick, so a tier change that happens *outside* the loop can re-arm it.
 *
 * The self-rescheduling loop picks its cadence from the tier each measurement produced, which was
 * sound while a measurement was the only thing that could change the tier. An observed exhaustion
 * is not (issue #504): it can raise the tier to the Hard Stop moments after a poll armed itself
 * for the five minutes an `ok` reading warranted, and nothing would re-measure until that elapsed —
 * leaving the app locked for minutes after the space came back.
 */
let pollTick: (() => void) | null = null;

/** Arm the next poll for the tier now in force, replacing any timer already waiting. */
function rearmPoll(tier: StorageTier): void {
  if (!monitoring || !pollTick) return;
  if (pollTimer !== null) clearTimeout(pollTimer);
  const tick = pollTick;
  pollTimer = setTimeout(tick, POLL_INTERVAL_MS[tier]);
}

export const useStorageStore = create<StorageStore>()((set, get) => ({
  persisted: false,
  estimate: null,
  ratio: 0,
  tier: 'ok',
  measuredTier: 'ok',
  exhaustion: null,
  lastCheckedAt: 0,
  warningDismissed: false,

  refresh: async () => {
    // Coalesce: a poll firing while a bulk write's gate is already measuring must not issue a
    // second `estimate()`, and both callers want the same answer anyway.
    if (inFlight) return inFlight;
    const sequence = (measurementSequence += 1);
    const run = (async () => {
      const [estimate, persisted] = await Promise.all([estimateStorage(), isStoragePersisted()]);
      const measuredTier = classifyStorageTier(estimate.ratio);
      set((state) => {
        const exhaustion = settleExhaustion(state.exhaustion, estimate, sequence);
        const tier = effectiveTier(measuredTier, exhaustion);
        const base = {
          estimate,
          persisted,
          ratio: estimate.ratio,
          measuredTier,
          exhaustion,
          tier,
          lastCheckedAt: Date.now(),
        };
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

  reportExhaustion: () => {
    set((state) => {
      const exhaustion: ObservedStorageExhaustion = {
        // Every measurement issued so far, in flight ones included, predates this failure.
        afterMeasurement: measurementSequence,
        measured: false,
        baselineAvailable: null,
      };
      return {
        exhaustion,
        tier: effectiveTier(state.measuredTier, exhaustion),
        // The state just worsened, so a previously-dismissed banner must come back.
        warningDismissed: false,
      };
    });
    // Tighten the poll to the cadence the new tier warrants. The loop picks its interval from
    // whatever the last *measurement* produced, so without this it would keep waiting out an
    // interval chosen while there was headroom — and the space could come back long before it
    // looked again (the only thing that then notices is a successful write).
    rearmPoll(get().tier);
    // Re-measure straight away rather than waiting for the poll: the banner quotes usage and
    // quota, and this is the measurement that establishes the headroom the latch clears against.
    // Best-effort — a failed estimate must not turn a failed write into an unhandled rejection.
    void get()
      .refresh()
      .catch(() => {});
  },

  reportWriteSucceeded: () => {
    const { exhaustion } = get();
    // Nothing observed, or nothing measured since — the common case, and it must cost a read and
    // a branch, because this runs on every successful database write.
    if (!exhaustion?.measured) return;
    set((state) => ({ exhaustion: null, tier: state.measuredTier }));
  },

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
      rearmPoll(get().tier);
    };
    pollTick = () => void tick();
    void tick();
  },

  stopMonitoring: () => {
    monitoring = false;
    pollTick = null;
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
 *
 * The re-measurement cannot, however, *clear* an observed out-of-space failure (issue #504) — the
 * estimate is precisely what was wrong — so a bulk write is still refused while one stands.
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
