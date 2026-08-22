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
 * Union two delta lists by id, keeping **one** row per id chosen by `prefer` (pure).
 *
 * Which copy is kept used to be "whichever was seen first", i.e. the local one — fine while every
 * id was minted randomly, because then a shared id could only ever be the *same* row, synced. A
 * one-shot operation that derives its delta ids (issue #696) breaks that: two devices independently
 * write the same id, each stamped by its own clock. Keeping the local copy would then give the two
 * devices different `createdAt`s for one row, and a CRDT whose inputs differ per device converges on
 * nothing — the stock replay in particular drops every movement ordered before an assertion, so the
 * two would disagree on which side of a cycle count the operation fell.
 *
 * So the pick is made from the rows' own content instead, which both devices read identically.
 */
function unionById<T extends { readonly id: string }>(
  local: readonly T[],
  remote: readonly T[],
  prefer: (held: T, candidate: T) => T,
): T[] {
  const byId = new Map<string, T>();
  for (const delta of [...local, ...remote]) {
    const held = byId.get(delta.id);
    byId.set(delta.id, held === undefined ? delta : prefer(held, delta));
  }
  return [...byId.values()];
}

/**
 * Merge two delta lists, de-duplicating by id and ordering chronologically.
 *
 * @internal Exported for unit tests only.
 */
export function mergeDeltas(
  local: readonly GaugeHistoryDelta[],
  remote: readonly GaugeHistoryDelta[],
): GaugeHistoryDelta[] {
  // The earliest copy of a shared id wins, then the smallest delta — see {@link unionById}. A
  // gauge's replay is a plain sum, so this only fixes the *order* the two devices see; the stock
  // replay below is where a differing pick would change the answer.
  const merged = unionById(local, remote, (held, candidate) => {
    if (held.createdAt !== candidate.createdAt) {
      return held.createdAt < candidate.createdAt ? held : candidate;
    }
    return held.netValueDelta <= candidate.netValueDelta ? held : candidate;
  });
  return merged.sort((a, b) =>
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
 * rows stamped the *same millisecond*, where there is no evidence of which came first: the count is
 * treated as the earlier event, so a movement sharing its instant is still applied on top. That is
 * the safe reading of a tie — the alternative discards a real movement, which is the failure §7.3's
 * whole delta design exists to prevent.
 *
 * The cost of that choice is a tie the rule gets *wrong*: a movement committed in the same
 * millisecond **before** a count is replayed as though it came after, so that device's own ledger
 * reconstructs a quantity its row does not hold, and the completeness guard in `reconcileStock`
 * leaves the placement on Last-Write-Wins until the next count of it re-bases the ledger. It needs
 * two stock transactions inside one millisecond on one device, which the UI cannot really produce
 * (each is a separate user action), and it heals itself. Nudging a count's stamp past its
 * placement's newest row would close it, and was tried: the newest row may be one a peer with a
 * fast clock synced in, so the nudge lands the count minutes ahead and swallows every local
 * movement until the wall clock catches up — an unbounded ratchet of the kind `updatedAtTrigger`
 * has to cap (issue #393), trading a sub-millisecond window for an open-ended one.
 *
 * `createdAt` is each device's own wall clock, deliberately **not** shifted by the sync `offset`
 * that LWW comparisons use: applying it would give the two devices different orderings of the same
 * rows, and a CRDT that is not commutative converges on nothing. So a badly skewed clock can order
 * a count against a movement wrongly, exactly as it can pick the wrong LWW winner. The stakes are
 * higher here — a mis-ordered movement is absorbed rather than overwritten — but there is no
 * device-independent ordering available to use instead.
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
  // Ids compare by code unit, not `localeCompare` — this order decides which movements survive,
  // so it must not vary with the device's locale.
  const byId = (a: StockQuantityDelta, b: StockQuantityDelta): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const ordered = [...deltas].sort((a, b) => a.createdAt - b.createdAt || rank(a) - rank(b) || byId(a, b));
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
/** Order a row's `assertedQuantity` totally, with a movement's `null` below every figure. */
function assertionRank(delta: StockQuantityDelta): number {
  return delta.assertedQuantity ?? Number.NEGATIVE_INFINITY;
}

export function reconcileStockQuantity(
  localDeltas: readonly StockQuantityDelta[],
  remoteDeltas: readonly StockQuantityDelta[],
): number {
  // The earliest copy of a shared id wins, tie-broken on the row's own figures — see
  // {@link unionById} for why the pick cannot simply be "the local one" now that a one-shot
  // operation derives its delta ids (issue #696).
  const merged = unionById(localDeltas, remoteDeltas, (held, candidate) => {
    if (held.createdAt !== candidate.createdAt) {
      return held.createdAt < candidate.createdAt ? held : candidate;
    }
    if (held.quantityDelta !== candidate.quantityDelta) {
      return held.quantityDelta < candidate.quantityDelta ? held : candidate;
    }
    // A movement (`null`) sorts before any assertion, so the two devices agree on which they hold.
    return assertionRank(held) <= assertionRank(candidate) ? held : candidate;
  });
  const total = replayStockQuantity(merged);
  return total < 0 ? 0 : total;
}
