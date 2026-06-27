/**
 * Storage quota tiers & the Hard Stop (spec §7.6.1, §7.4).
 *
 * Pure, side-effect-free classification of an OPFS usage ratio into the tiered
 * degradation states. Isolated here so the thresholds are unit-tested and shared
 * by both the telemetry store and the UI banners.
 */

export type StorageTier = 'ok' | 'warning' | 'critical' | 'locked';

/** Fractional usage thresholds (usage / quota) at which each tier begins. */
export const STORAGE_THRESHOLDS = {
  /** Dismissible yellow banner. */
  warning: 0.8,
  /** Persistent red banner; non-essential features disabled. */
  critical: 0.9,
  /** Hard Stop: only DELETEs permitted. */
  locked: 0.95,
} as const;

export function classifyStorageTier(ratio: number): StorageTier {
  // No/garbage quota information must never trip a false Hard Stop.
  if (!Number.isFinite(ratio) || ratio < STORAGE_THRESHOLDS.warning) return 'ok';
  if (ratio < STORAGE_THRESHOLDS.critical) return 'warning';
  if (ratio < STORAGE_THRESHOLDS.locked) return 'critical';
  return 'locked';
}

/**
 * The Hard Stop (spec §7.6.1): at the locked tier all INSERT/UPDATE operations are
 * suspended; only DELETEs (to reclaim space) are allowed. Repository writes in
 * later phases must consult this before mutating.
 */
export function isWriteSuspended(tier: StorageTier): boolean {
  return tier === 'locked';
}

/** Non-essential features (e.g. new high-res image uploads) are disabled from critical upward. */
export function areNonEssentialFeaturesDisabled(tier: StorageTier): boolean {
  return tier === 'critical' || tier === 'locked';
}
