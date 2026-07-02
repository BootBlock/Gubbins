/**
 * Delta-CRDT reconciliation for Consumable-Gauge net values (spec §4.1.2, §7.3, Phase 7).
 *
 * `current_net_value` must NEVER be resolved by Last-Write-Wins: that would silently
 * discard one device's offline consumption. Instead the engine extracts the relative
 * net-value deltas from each side's `item_history` (Activity Ledger), de-duplicates
 * them by the history row's UUID (the same physical event seen on two devices counts
 * once), and replays them chronologically over the item's original capacity to obtain
 * the true converged value. All pure and unit-tested.
 */
import type { GaugeHistoryDelta } from './types';

/** Merge two delta lists, de-duplicating by id and ordering chronologically. */
export function mergeDeltas(
  local: readonly GaugeHistoryDelta[],
  remote: readonly GaugeHistoryDelta[],
): GaugeHistoryDelta[] {
  const byId = new Map<string, GaugeHistoryDelta>();
  for (const delta of [...local, ...remote]) {
    if (!byId.has(delta.id)) byId.set(delta.id, delta);
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
  );
}

/**
 * Replay merged gauge deltas for one item over a starting capacity to get the
 * converged `current_net_value`. The result is clamped to `[0, grossCapacity]` so
 * concurrent over-consumption can never drive the gauge negative or above full.
 */
export function replayGaugeValue(grossCapacity: number, deltas: readonly GaugeHistoryDelta[]): number {
  const total = deltas.reduce((sum, d) => sum + d.netValueDelta, 0);
  const value = grossCapacity + total;
  if (value < 0) return 0;
  if (value > grossCapacity) return grossCapacity;
  return value;
}

/**
 * Convenience: merge then replay for a single item. `localDeltas`/`remoteDeltas` are
 * the gauge history rows for *this* item from each snapshot.
 */
export function reconcileGauge(
  grossCapacity: number,
  localDeltas: readonly GaugeHistoryDelta[],
  remoteDeltas: readonly GaugeHistoryDelta[],
): number {
  return replayGaugeValue(grossCapacity, mergeDeltas(localDeltas, remoteDeltas));
}
