/**
 * Cancelling the surplus when one loan's stock moved at two placements (issue #711).
 *
 * A loan whose ids are derived from a one-shot operation — converting a booking (issue #542) — is
 * **one row** on both devices however many times it is performed offline. The stock it moves is
 * not. `stockDeltaIdExpression` derives a captured delta's id from the operation key *and the
 * placement it moved* (issue #696), which is right for an operation both devices run against the
 * same synced state: they touch the same placements, so they mint the same ids and the id-union
 * collapses their two ledgers to one.
 *
 * A loan's draw is not that operation. It takes the unit from wherever *this* device last saw the
 * asset, so a device that moved it offline before converting draws it from somewhere else, and the
 * two draws take two ids at two placements. `reconcileStockQuantity` replays a *single* placement's
 * ledger, so the two are never compared: each device imports the other's row and both `-1`s stand.
 * The same is true of the return, which restores to the placement its own device's copy of the row
 * recorded.
 *
 * Left alone the asymmetric case loses the unit outright — both devices convert, exactly one
 * returns, and the single surviving `checkouts` row is closed while the other device's draw has no
 * open loan left to give it back. On-hand and on-loan both end at zero, and no further sync
 * recovers it.
 *
 * ## What this pass does
 *
 * A loan's draw has an **expected shape** the merged ledger can be checked against: it moved
 * `quantity` units out of exactly ONE placement, and (once returned) back into exactly one. So for
 * each of the loan's two stock operations — the draw, keyed by `checkouts.stock_operation_key`,
 * and the return, keyed by `checkInId('stock', checkoutId)` — this pass gathers the merged
 * ledger's rows under that key. Where they span more than one placement the operation was
 * performed twice against different states: one placement's rows are kept and every other
 * placement's are **cancelled** by appending an equal-and-opposite row to the append-only ledger.
 *
 * The two keys are handled separately on purpose. Cancelling by loan rather than by operation
 * would, in the asymmetric case, throw away the one return that did happen along with the draw
 * beside it, and the unit would be lost exactly as before.
 *
 * ## Why both devices agree
 *
 * Every input is the id-union of the two snapshots, which both devices compute identically, and
 * every output is a pure function of it:
 *
 *  - **Which placement is kept** is pinned by any cancellation the ledger already carries, and
 *    otherwise is the candidate that leaves no involved placement replaying below zero — see
 *    {@link keptPlacement} for the rule and for why it is deliberately not decided by which copy
 *    was written first.
 *  - **A cancellation's own row** is derived from the row it cancels: id `~<cancelled id>`, its
 *    placement, its `created_at`, and the negation of its `quantity_delta`. Two devices that both
 *    run the pass write the byte-identical row, so the union keeps one, and a device that runs it
 *    again re-derives the same row for the merge's `INSERT OR IGNORE` to skip. It shares its
 *    target's `created_at` and carries no `asserted_quantity`, so the two rank together in the
 *    replay's order and an assertion that supersedes the one supersedes the other.
 *
 * A cancellation is an ordinary movement row, so nothing downstream needs to know it is one — the
 * replay, the completeness guard and the compaction sweep all read it as the ledger entry it is.
 *
 * ## What it deliberately leaves alone
 *
 * The pass is conservative in the same way `reconcileStock` is, and skips the whole operation when
 * it cannot be sure of the ground it is standing on:
 *
 *  - a key whose rows a compaction checkpoint has already superseded (issue #544) contributes
 *    nothing to any replay, so those rows are filtered out first — without which a placement
 *    compacted on one device and not the other would read as a split that is not there;
 *  - a placement whose ledger does not reconstruct its own stored quantity on a side that holds it
 *    is baseline-less, and the same reasoning that leaves it on last-write-wins in `reconcileStock`
 *    applies here: appending to a ledger that already fails to explain its row cannot be shown to
 *    improve it;
 *  - the loan's own `source_location_id` is left exactly as last-write-wins settled it. Which
 *    placement the units are recorded against is recoverable with a move; the count is not, and
 *    rewriting the column would put a second cross-device repair on the same row as the #542
 *    return-preservation pass for no gain to the invariant this exists to hold.
 */
import type { SqlRow } from '@/db/rpc/driver';
import { replayStockQuantity } from './delta-crdt';
import type { StockQuantityDelta, SyncSnapshot } from './types';

/** The prefix marking a row that cancels another (see the module note). */
const CANCELLATION_PREFIX = '~';

/**
 * The stable placement id a `stock_deltas` or `stock_batches` row belongs to, so the same placement
 * matches across two independently-built snapshots. `\0` cannot occur in a UUID or a batch key, so
 * the composite never collides. Shared with `./reconcile`, whose own placement maps are compared
 * against these by this very key — there can only be one definition of it.
 */
export function placementIdOf(row: SqlRow): string {
  return `${String(row.item_id)}\0${String(row.location_id)}\0${String(row.batch_key)}`;
}

/**
 * A stored column as a number, matching `reconcile`'s own reading of the same rows: a `bigint` a
 * driver may hand back is narrowed, and everything else — `null` included — passes through, so a
 * movement's absent `asserted_quantity` stays absent instead of coercing to a stated zero.
 */
function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

/** A row's `asserted_quantity` as the replay reads it — a finite figure, or `null` for a movement. */
function asserted(row: SqlRow): number | null {
  const value = num(row.asserted_quantity);
  return Number.isFinite(value) ? value : null;
}

function toDelta(row: SqlRow): StockQuantityDelta {
  return {
    id: String(row.id),
    quantityDelta: num(row.quantity_delta),
    createdAt: num(row.created_at),
    assertedQuantity: asserted(row),
  };
}

/**
 * Compare two rows by the total order {@link replayStockQuantity} replays in —
 * `(created_at, assertion-before-movement, code-unit id)`. Kept in step with it by hand because
 * the replay sorts projected deltas and this sorts raw rows; both must agree on what "earlier"
 * means, or {@link firstLiveRow} would name a different row as the one that supersedes the
 * ledger before it than the replay does.
 */
function compareRows(a: SqlRow, b: SqlRow): number {
  const byTime = num(a.created_at) - num(b.created_at);
  if (byTime !== 0) return byTime;
  const rank = (row: SqlRow): number => (asserted(row) === null ? 1 : 0);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const left = String(a.id);
  const right = String(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Group rows by placement id, each group left in replay order. */
function groupByPlacement(rows: readonly SqlRow[] | undefined): Map<string, SqlRow[]> {
  const map = new Map<string, SqlRow[]>();
  for (const row of rows ?? []) {
    const id = placementIdOf(row);
    const list = map.get(id);
    if (list === undefined) map.set(id, [row]);
    else list.push(row);
  }
  for (const list of map.values()) list.sort(compareRows);
  return map;
}

/**
 * The id-union of both sides' `stock_deltas`, one row per id.
 *
 * The copy kept is chosen from the rows' own content, never by which side is local: a derived id
 * genuinely exists twice, once per device, each stamped by its own clock, so "keep the local one"
 * would give the two devices different inputs and a pass that agrees with nobody.
 *
 * The three tiers — earliest `created_at`, then smallest movement, then a movement ahead of any
 * assertion — are `reconcileStockQuantity`'s `prefer` callback, tier for tier. They have to be:
 * this pass and the replay it feeds must pick the *same* copy, or a placement's newest assertion
 * would be one row here and another there. It cannot simply call `unionById`, which unions the
 * projected {@link StockQuantityDelta}s while the cancellation below needs the raw row's placement
 * columns; keeping the rule in step by hand is the price of that.
 */
function unionDeltas(local: SyncSnapshot, remote: SyncSnapshot): SqlRow[] {
  // A movement's `null` sorts below every stated figure, exactly as `assertionRank` orders it.
  const rank = (row: SqlRow): number => asserted(row) ?? Number.NEGATIVE_INFINITY;
  const merged = new Map<string, SqlRow>();
  for (const row of [...(local.stockDeltas ?? []), ...(remote.stockDeltas ?? [])]) {
    const id = String(row.id);
    const held = merged.get(id);
    if (held === undefined) {
      merged.set(id, row);
      continue;
    }
    if (num(held.created_at) !== num(row.created_at)) {
      merged.set(id, num(held.created_at) < num(row.created_at) ? held : row);
    } else if (num(held.quantity_delta) !== num(row.quantity_delta)) {
      merged.set(id, num(held.quantity_delta) < num(row.quantity_delta) ? held : row);
    } else {
      merged.set(id, rank(held) <= rank(row) ? held : row);
    }
  }
  return [...merged.values()];
}

/**
 * The operation key an id was derived from, or `null` for a row that carries none.
 *
 * A captured delta's id is either 32 random hex characters, a version-5 UUID (a compaction
 * checkpoint), or `<key>|<item>|<location>|<batch>|<n>` — only the last carries a key, and only
 * the first `|` bounds it. A cancellation this pass wrote is excluded outright: its id inherits its
 * target's, so the segment before its first `|` would name a key it is no part of.
 */
function operationKeyOf(id: string): string | null {
  if (id.startsWith(CANCELLATION_PREFIX)) return null;
  const bar = id.indexOf('|');
  return bar <= 0 ? null : id.slice(0, bar);
}

/** The row cancelling `row`: same placement and instant, opposite movement, derived id. */
function cancellationOf(row: SqlRow): SqlRow {
  return {
    id: `${CANCELLATION_PREFIX}${String(row.id)}`,
    item_id: String(row.item_id),
    location_id: String(row.location_id),
    batch_key: String(row.batch_key),
    quantity_delta: -num(row.quantity_delta),
    created_at: num(row.created_at),
    asserted_quantity: null,
  };
}

/** What {@link resolveSplitLoanStock} found, for the caller to insert and to converge. */
export interface SplitLoanStockRepair {
  /** The cancelling `stock_deltas` rows to append to the ledger (union-by-id, INSERT OR IGNORE). */
  readonly cancellations: readonly SqlRow[];
  /** The placement ids the repair touches, for the quantity replay to cover. */
  readonly placements: ReadonlySet<string>;
}

const NOTHING: SplitLoanStockRepair = { cancellations: [], placements: new Set() };

/**
 * Find every loan whose draw or return moved stock at more than one placement, and cancel the
 * surplus. See the module note for the rule, and for why both devices reach it.
 *
 * `finalCheckouts` is the post-merge loan set; `returnKeys` maps a loan id to the operation key
 * its return was captured under (`checkInId('stock', id)`, precomputed by the caller because it is
 * asynchronous and this is not). A loan missing from `returnKeys` simply has its return left
 * unexamined, which is the pre-#711 behaviour rather than a wrong answer.
 */
export function resolveSplitLoanStock(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  finalCheckouts: ReadonlyMap<string, SqlRow>,
  returnKeys: ReadonlyMap<string, string>,
  finalItemIds: ReadonlySet<string>,
): SplitLoanStockRepair {
  // The loans worth examining: only one that recorded a draw key has stock the merge can pair up.
  const loans: { drawKey: string; returnKey: string | undefined }[] = [];
  const keys = new Set<string>();
  for (const loan of finalCheckouts.values()) {
    const drawKey = loan.stock_operation_key;
    if (typeof drawKey !== 'string' || drawKey.length === 0) continue;
    if (!finalItemIds.has(String(loan.item_id))) continue;
    const returnKey = returnKeys.get(String(loan.id));
    loans.push({ drawKey, returnKey });
    keys.add(drawKey);
    if (returnKey !== undefined) keys.add(returnKey);
  }
  if (loans.length === 0) return NOTHING;

  const mergedByPlacement = groupByPlacement(unionDeltas(local, remote));
  const localByPlacement = groupByPlacement(local.stockDeltas);
  const remoteByPlacement = groupByPlacement(remote.stockDeltas);
  const localQuantities = placementQuantities(local.tables.stock_batches);
  const remoteQuantities = placementQuantities(remote.tables.stock_batches);

  // The operation rows that still reach a replayed total, grouped by key and then by placement.
  // Anything a placement's newest assertion supersedes — a compaction checkpoint, a cycle count —
  // is skipped, so a placement compacted on one device only cannot read as a split.
  const byKey = new Map<string, Map<string, SqlRow[]>>();
  for (const [id, rows] of mergedByPlacement) {
    for (let i = firstLiveRow(rows); i < rows.length; i += 1) {
      const row = rows[i]!;
      const key = operationKeyOf(String(row.id));
      if (key === null || !keys.has(key)) continue;
      let places = byKey.get(key);
      if (places === undefined) {
        places = new Map();
        byKey.set(key, places);
      }
      const kept = places.get(id);
      if (kept === undefined) places.set(id, [row]);
      else kept.push(row);
    }
  }

  const merged = new Set<string>();
  for (const rows of mergedByPlacement.values()) for (const row of rows) merged.add(String(row.id));

  const cancellations: SqlRow[] = [];
  const placements = new Set<string>();
  for (const loan of loans) {
    const draw = byKey.get(loan.drawKey);
    const restore = loan.returnKey === undefined ? undefined : byKey.get(loan.returnKey);
    if ((draw?.size ?? 0) < 2 && (restore?.size ?? 0) < 2) continue;

    // Every placement either half touches must have a ledger that explains its own stored quantity
    // on each side that holds one, or the replay this pass appends to cannot be trusted (see the
    // module note). The two halves stand or fall together, because keeping the draw at one
    // placement and the return at another is what puts the loan's two ends out of step.
    const involved = new Set([...(draw?.keys() ?? []), ...(restore?.keys() ?? [])]);
    const trustworthy = [...involved].every(
      (id) =>
        sideExplainsItsOwnQuantity(id, localByPlacement, localQuantities) &&
        sideExplainsItsOwnQuantity(id, remoteByPlacement, remoteQuantities),
    );
    if (!trustworthy) continue;

    // The loan's placement: chosen from the draw, which is the half a wrong choice actually costs
    // — a draw kept where the merged history has no stock left is floored at zero and the shortfall
    // is swallowed. The return follows it wherever it went there too, so the unit comes back to the
    // placement it left; only a return that never touched that placement picks for itself.
    const drawn = draw === undefined ? undefined : keptPlacement(draw, mergedByPlacement, merged);
    const cancel = (places: ReadonlyMap<string, SqlRow[]>, kept: string): void => {
      for (const [id, rows] of places) {
        if (id === kept) continue;
        for (const row of rows) cancellations.push(cancellationOf(row));
        placements.add(id);
      }
      // The kept placement is settled from the same union, so it is converged with the rest.
      placements.add(kept);
    };
    if (draw !== undefined && draw.size >= 2) cancel(draw, drawn!);
    if (restore !== undefined && restore.size >= 2) {
      const kept =
        drawn !== undefined && restore.has(drawn) ? drawn : keptPlacement(restore, mergedByPlacement, merged);
      cancel(restore, kept);
    }
  }

  return cancellations.length === 0 ? NOTHING : { cancellations, placements };
}

/**
 * The index a placement's ordered ledger becomes *live* from: one past its newest
 * `asserted_quantity` row, or 0 when it has none.
 *
 * Exactly {@link replayStockQuantity}'s `from`. An assertion states the quantity outright, so its
 * own `quantity_delta` is never summed and neither is anything before it — which means a row at or
 * below this index reaches no replayed total, and cancelling one would move a placement by a delta
 * the replay had never applied.
 */
function firstLiveRow(rows: readonly SqlRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (asserted(rows[i]!) !== null) return i + 1;
  }
  return 0;
}

/**
 * The placement an operation's rows are kept at, cancelling every other placement's.
 *
 * Two rules, in order, and both are functions of the merged ledger alone — which is what makes two
 * devices reach the same answer, and one device reach the same answer twice:
 *
 *  1. **Already decided.** Once a cancellation for this operation is in the ledger, exactly one
 *     placement's rows are left uncancelled and that is the choice, permanently. Without this the
 *     rule below could be re-decided by later movements at the same placements, and a second,
 *     contradictory cancellation would be written beside the first.
 *  2. **The choice that leaves no placement owing stock.** Cancelling a placement's rows changes
 *     what its ledger replays to, so each candidate is tried and the ones that would drive an
 *     involved placement below zero are rejected: the replay floors a negative total at zero, so a
 *     draw kept where the merged history has already emptied the shelf loses its unit there exactly
 *     as it did before this pass existed. Candidates are tried in placement-id order and the first
 *     that survives is taken, so a loan whose placements are all viable still lands on one answer.
 *
 * Deliberately not decided by *when* the two copies were written. Rows minted microseconds apart
 * routinely share a millisecond, and `stock_deltas` breaks that tie on the id — which is to say
 * arbitrarily. A rule reading the ledger's totals is indifferent to the order the ties fell in.
 */
function keptPlacement(
  places: ReadonlyMap<string, SqlRow[]>,
  mergedByPlacement: ReadonlyMap<string, SqlRow[]>,
  merged: ReadonlySet<string>,
): string {
  const candidates = [...places.keys()].sort();
  const uncancelled = candidates.filter((id) =>
    places.get(id)!.every((row) => !merged.has(`${CANCELLATION_PREFIX}${String(row.id)}`)),
  );
  if (uncancelled.length === 1) return uncancelled[0]!;

  for (const keep of candidates) {
    const viable = candidates.every((id) => {
      const rows = (mergedByPlacement.get(id) ?? []).map(toDelta);
      const after = id === keep ? rows : [...rows, ...places.get(id)!.map((r) => toDelta(cancellationOf(r)))];
      return replayStockQuantity(after) >= 0;
    });
    if (viable) return keep;
  }
  return candidates[0]!;
}

/**
 * One side's `stock_batches` quantities by placement id — the right-hand side of the
 * ledger-completeness guard, here and in `reconcileStock`, which shares this.
 */
export function placementQuantities(rows: readonly SqlRow[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows ?? []) map.set(placementIdOf(row), num(row.quantity));
  return map;
}

/**
 * Whether one side's own ledger for a placement reconstructs the quantity that side stored —
 * `reconcileStock`'s guard (2), asked of each side separately because that is the whole question:
 * whether *that* device's rows explain *that* device's figure.
 *
 * A side holding neither a `stock_batches` row nor a ledger row for the placement passes: it has
 * recorded nothing the replay could contradict. A side with ledger rows but **no** row for them to
 * explain does not, and agreeing with `reconcileStock` on that is load-bearing rather than
 * fastidious — a cancellation this pass appends that the quantity pass then declines to settle
 * leaves the placement's ledger permanently unable to explain its own row, and so on last-write-wins
 * for good.
 */
function sideExplainsItsOwnQuantity(
  id: string,
  byPlacement: ReadonlyMap<string, SqlRow[]>,
  quantities: ReadonlyMap<string, number>,
): boolean {
  const rows = byPlacement.get(id) ?? [];
  const stored = quantities.get(id);
  if (stored === undefined) return rows.length === 0;
  return replayStockQuantity(rows.map(toDelta)) === stored;
}
