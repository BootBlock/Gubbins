/**
 * Last-Write-Wins resolution for discrete fields (spec §7.3 step 2, Phase 7).
 *
 * Pure comparison of two row timestamps to decide which side wins. The local
 * timestamp must already have the §7.3 clock offset applied by the caller; ties go
 * to the remote (idempotent: re-running a sync with equal clocks is a no-op).
 */

export type LwwOutcome = 'LOCAL_WINS' | 'REMOTE_WINS';

/**
 * Resolve a row present on both sides. `localUpdatedAt` is the local `updated_at`
 * **already offset to server time**. Strictly-greater-local wins; equal or
 * strictly-greater-remote yields the remote (so a redundant re-sync changes nothing).
 */
export function resolveLww(localUpdatedAt: number, remoteUpdatedAt: number): LwwOutcome {
  return localUpdatedAt > remoteUpdatedAt ? 'LOCAL_WINS' : 'REMOTE_WINS';
}
