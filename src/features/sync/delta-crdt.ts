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
 * Replay one placement's `stock_deltas` in order to the quantity they describe — **unclamped**,
 * and assuming the list is already de-duplicated (issue #188, issue #633).
 *
 * Ordinary movements are relative, so they accumulate over a base of **0** (a batch has no
 * structural capacity — its whole life is deltas). A row carrying an `assertedQuantity` is not a
 * movement but a *physical count*: it states what was on the shelf, which supersedes every
 * movement recorded before it. So the replay restarts from the **newest** assertion and applies
 * only what came after. Counting the same shelf on two devices therefore lands on the count, not
 * on the count minus a second copy of its own correction.
 *
 * Ordering is `(createdAt, count-before-movement, id)` — computed from replicated values alone, so
 * both devices reach it identically and the result is commutative. The middle term only decides
 * rows stamped the *same millisecond*, where there is genuinely no evidence of which came first: a
 * count is then treated as the earlier event, so a movement sharing its instant is still applied on
 * top. That is the safe reading of a tie — the alternative discards a real movement, which is the
 * failure §7.3's whole delta design exists to prevent.
 *
 * Unclamped because the caller decides what a negative total means: converging a placement floors
 * it at 0 (see {@link reconcileStockQuantity}), while checking whether a device's own ledger
 * reconstructs its own stored quantity must compare the honest figure — a ledger that sums to −5
 * beside a row reading 0 is an incomplete ledger, not a floored one.
 *
 * @internal Exported for unit tests and the reconcile completeness guard.
 */
export function replayStockQuantity(deltas: readonly StockQuantityDelta[]): number {
  const rank = (d: StockQuantityDelta): number => (d.assertedQuantity === null ? 1 : 0);
  const ordered = [...deltas].sort(
    (a, b) => a.createdAt - b.createdAt || rank(a) - rank(b) || a.id.localeCompare(b.id),
  );
  let from = 0;
  let total = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const asserted = ordered[i]!.assertedQuantity;
    if (asserted !== null) {
      from = i + 1;
      total = asserted;
      break;
    }
  }
  for (let i = from; i < ordered.length; i++) total += ordered[i]!.quantityDelta;
  return total;
}

/**
 * The discrete-stock analogue of {@link reconcileGauge} (issue #188). A `(item, location, batch)`
 * placement's converged quantity is the id-union of both sides' `stock_deltas` replayed by
 * {@link replayStockQuantity}, clamped at a floor of 0. De-duplication by the delta's own id means
 * the same physical movement seen on two devices counts once; the union is commutative, so both
 * devices reach the same quantity.
 *
 * The floor is the only clamp (there is no ceiling): concurrent over-consumption that drives the
 * total negative converges to 0 on every replay rather than leaving a latent negative. Recomputing
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
  const total = replayStockQuantity([...byId.values()]);
  return total < 0 ? 0 : total;
}
