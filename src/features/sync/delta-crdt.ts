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
import type { GaugeHistoryDelta, StockQuantityDelta } from './types';

/**
 * Merge two delta lists, de-duplicating by id and ordering chronologically.
 *
 * @internal Exported for unit tests only.
 */
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
 *
 * @internal Exported for unit tests only.
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

/**
 * The discrete-stock analogue of {@link reconcileGauge} (issue #188). A `(item, location, batch)`
 * placement's converged quantity is the id-unioned sum of every signed `stock_deltas` movement,
 * over a base of **0** (a batch has no structural capacity — its whole life is deltas), clamped at
 * a floor of 0. De-duplication by the delta's own id means the same physical movement seen on two
 * devices counts once; the union is commutative, so both devices reach the same quantity.
 *
 * The floor is the only clamp (there is no ceiling): concurrent over-consumption that drives the
 * sum negative converges to 0 on every replay rather than leaving a latent negative. Recomputing
 * from the deltas each sync makes this self-correcting, exactly as the gauge re-clamps its value.
 */
export function reconcileStockQuantity(
  localDeltas: readonly StockQuantityDelta[],
  remoteDeltas: readonly StockQuantityDelta[],
): number {
  const byId = new Map<string, StockQuantityDelta>();
  for (const delta of [...localDeltas, ...remoteDeltas]) {
    if (!byId.has(delta.id)) byId.set(delta.id, delta);
  }
  let sum = 0;
  for (const delta of byId.values()) sum += delta.quantityDelta;
  return sum < 0 ? 0 : sum;
}
