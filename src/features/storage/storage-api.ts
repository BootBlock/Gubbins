/**
 * Thin, guarded wrappers over the StorageManager APIs (spec §2, §7.4, §7.6).
 * Every call degrades safely on browsers/contexts where the API is missing.
 */
import { hasStorageEstimate, hasStoragePersist } from '@/lib/env/feature-detection';

export interface StorageEstimateResult {
  /** Bytes used by this origin (best-effort; browsers may pad/obfuscate). */
  readonly usage: number;
  /** Total bytes available to this origin. */
  readonly quota: number;
  /** usage / quota in the range 0..1 (0 when unknown). */
  readonly ratio: number;
  /** Whether the estimate API was actually available. */
  readonly supported: boolean;
}

export async function estimateStorage(): Promise<StorageEstimateResult> {
  if (!hasStorageEstimate()) {
    return { usage: 0, quota: 0, ratio: 0, supported: false };
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const ratio = quota > 0 ? usage / quota : 0;
    return { usage, quota, ratio, supported: true };
  } catch {
    return { usage: 0, quota: 0, ratio: 0, supported: false };
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (!hasStoragePersist() || typeof navigator.storage.persisted !== 'function') return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Ask the browser to mark this origin's storage as persistent (spec §2). Returns
 * the resulting persisted state. If this returns false the UI must warn the user
 * their data is "ephemeral" and nudge them to install the PWA or enable Cloud Sync.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!hasStoragePersist()) return false;
  try {
    if (await isStoragePersisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
