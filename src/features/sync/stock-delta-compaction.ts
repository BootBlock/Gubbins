/**
 * Keeping the `stock_deltas` convergence ledger bounded (issue #544).
 *
 * The ledger is append-only by construction: capture triggers write a row for every quantity
 * change and an immutability trigger stops any of them being edited. Nothing removed one except
 * the `items` cascade, so the table — carried whole in every snapshot pushed to and pulled from
 * the shared folder — grew monotonically with the number of stock movements ever made. The
 * `item_history` retention prune reclaimed OPFS space that this quietly re-consumed.
 *
 * Two sweeps bound it, both run once per sync pass after the merge has been applied and before the
 * merged snapshot is read back for the push (see `sweepAndReadMerged` in `./merge`):
 *
 *  1. **Orphan prune** — a delta whose `(item_id, location_id, batch_key)` names no live
 *     `stock_batches` row describes a placement this device no longer has. Deleting a location
 *     drops its batch rows while `location_id` is a plain column with no cascade, so those deltas
 *     were stranded permanently.
 *  2. **Era compaction** — a placement's movements older than the retention horizon are replaced
 *     by a single **checkpoint**: one row asserting the quantity the era replays to. This is what
 *     bounds a *live* placement, which is where the growth actually is (an emptied batch row is
 *     set to 0, never deleted, so the orphan prune never reaches it).
 *
 * Compaction is exact rather than approximate, because the replay already has the concept it
 * needs. `replayStockQuantity` restarts from the newest `asserted_quantity` and applies only what
 * follows (issue #633), so one row asserting the era's own replayed total, stamped just before the
 * oldest surviving movement, is **replay-equivalent** to the era it replaces — for that device and
 * for every peer that unions it in. No schema change, no new column, no second reconciliation
 * rule: the checkpoint is an ordinary ledger row that the CRDT already knows how to read.
 *
 * Two things make that substitution safe, and neither is optional. A checkpoint is an
 * **assertion**, so it is only minted for a placement whose whole ledger already reconstructs its
 * stored quantity — see the completeness gate in {@link sweepStockDeltas}. And it is stamped
 * strictly after every row it summarises — see {@link checkpointStamp}.
 *
 * The safety argument for discarding the era is `STOCK_DELTA_RETENTION_MS`'s, and it rests on the
 * horizon being no shorter than the tombstone TTL. Read that note before changing either.
 */
import type { IDatabaseDriver, SqlRow, SqlStatement } from '@/db/rpc/driver';
import { STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import { uuidv5 } from '@/lib/derived-uuid';
import { replayStockQuantity } from './delta-crdt';
import type { StockQuantityDelta } from './types';

/**
 * Namespace for a checkpoint's deterministic id (issue #544).
 *
 * Derived rather than random for the same reason a finalise derives its ids: two devices that
 * summarise the same placement at the same cutoff must produce the *same* row, or the id-union
 * would keep both and the ledger would grow by one checkpoint per device per sweep instead of
 * collapsing to one. A v5 UUID is also structurally distinct from the two id shapes the capture
 * triggers mint — 32 undashed hex characters from `randomblob`, and the `|`-separated derivation
 * an operation key produces — so a checkpoint can never collide with a captured movement.
 */
const CHECKPOINT_ID_NAMESPACE = 'c0f4b2d6-1950-4e00-8b00-000000000544';

/**
 * How many statements one compaction transaction may carry — a soft ceiling, checked between
 * placements, so a single placement is never split across two commits.
 */
const COMPACTION_BATCH_STATEMENTS = 500;

/** A `(item, location, batch)` placement — the grain the ledger and the CRDT both work at. */
export interface PlacementKey {
  readonly itemId: string;
  readonly locationId: string;
  readonly batchKey: string;
}

/** What one sweep removed, for tests and diagnostics. */
export interface StockDeltaSweepResult {
  /** Rows deleted because their placement no longer exists. */
  readonly orphansPruned: number;
  /** Rows replaced by a checkpoint (the checkpoints themselves are not counted). */
  readonly erasCompacted: number;
  /** Placements that gained a checkpoint. */
  readonly placementsCompacted: number;
}

/**
 * The deterministic id of the checkpoint summarising `key`'s ledger up to `cutoff`.
 *
 * A pure function of its inputs, which is the convergence property: two devices sweeping the same
 * placement at the same cutoff derive the same id, so their checkpoints merge to one row.
 *
 * @internal Exported for unit tests only.
 */
export function checkpointId(key: PlacementKey, cutoff: number): Promise<string> {
  return uuidv5(`${key.itemId}|${key.locationId}|${key.batchKey}@${cutoff}`, CHECKPOINT_ID_NAMESPACE);
}

/** The two figures a checkpoint carries, computed from the era it replaces (pure). */
export interface EraSummary {
  /** What the era replays to — the checkpoint's `asserted_quantity`, and the replay's new base. */
  readonly assertedQuantity: number;
  /** The era's net movement — the checkpoint's `quantity_delta`; see {@link summariseEra}. */
  readonly netDelta: number;
}

/**
 * Summarise an era of a placement's deltas into the checkpoint that replaces it (pure).
 *
 * `assertedQuantity` is the era's own replay, which is what makes the substitution exact: a replay
 * over `[checkpoint, ...survivors]` restarts at the checkpoint and adds the survivors, and a replay
 * over `[...era, ...survivors]` restarts at whatever the era's newest assertion was (or 0) and adds
 * the rest — the same figure, because the checkpoint *is* that figure.
 *
 * `netDelta` is the era's net movement. The replay never reads an assertion row's own
 * `quantity_delta` — it restarts *from* the assertion, so the row's relative figure is skipped, and
 * any older assertion is skipped with everything else before it. Carrying the era's net movement
 * there is therefore free, and it keeps `SUM(quantity_delta)` over a placement's whole ledger
 * exactly what it was before the sweep, which is the cheap invariant several checks read.
 */
export function summariseEra(era: readonly StockQuantityDelta[]): EraSummary {
  return {
    assertedQuantity: replayStockQuantity(era),
    netDelta: era.reduce((sum, d) => sum + d.quantityDelta, 0),
  };
}

/**
 * Widen a driver value to a number without coercing it, so `NULL` stays `NULL`.
 *
 * The same helper `./reconcile` uses, and for the same reason: `Number(null)` is `0`, which would
 * read every ordinary movement as an assertion of zero and make the checkpoint state that the
 * shelf was empty.
 */
function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

/** Project a raw `stock_deltas` row to the shape the replay reads. */
function toDelta(row: SqlRow): StockQuantityDelta {
  const asserted = num(row.asserted_quantity);
  return {
    id: String(row.id),
    quantityDelta: num(row.quantity_delta),
    createdAt: num(row.created_at),
    // Mirrors `byPlacement` in `./reconcile`: anything that is not a finite number — NULL, or a
    // column a pre-#633 peer never sent — is the ordinary movement the row was recorded as.
    assertedQuantity: Number.isFinite(asserted) ? asserted : null,
  };
}

/**
 * Delete every delta whose placement has no live `stock_batches` row.
 *
 * Outcome-neutral by construction: `reconcileStock` resolves a placement only when
 * `replay(deltas) == stock_batches.quantity` on both sides, and a placement with no row has no
 * quantity to match, so it was already skipped with these rows present. Removing them changes no
 * merge result — only the size of the table and of every snapshot built from it.
 *
 * The `EXISTS` matches on the three placement columns rather than reconstructing `stock_batches.id`
 * so it stays independent of that id's separator; `UNIQUE (item_id, location_id, batch_key)` makes
 * it an index lookup either way.
 */
async function pruneOrphans(driver: IDatabaseDriver): Promise<number> {
  const result = await driver.execute(
    `DELETE FROM stock_deltas
      WHERE NOT EXISTS (
        SELECT 1 FROM stock_batches sb
         WHERE sb.item_id = stock_deltas.item_id
           AND sb.location_id = stock_deltas.location_id
           AND sb.batch_key = stock_deltas.batch_key);`,
  );
  return result.rowsModified;
}

/**
 * The instant a sweep at `cutoff` stamps its checkpoints at, and the exclusive upper bound of the
 * era each one summarises.
 *
 * One millisecond below the cutoff, and the era is everything strictly older *than the stamp* —
 * not than the cutoff. The gap matters because the era's rows do not stay deleted: an unswept peer
 * still holds them and hands them straight back on the next merge, and it is the checkpoint sorting
 * **after** them that makes the replay discard them as superseded. Were the era `< cutoff` while
 * the stamp sat at `cutoff − 1`, a row stamped at exactly `cutoff − 1` would be summarised *and*
 * tie with the checkpoint on re-import — and `replayStockQuantity` orders an assertion before a
 * movement at equal `createdAt`, so that row would be applied on top of a checkpoint that already
 * contained it. Excluding the stamp from the era leaves nothing that can tie from below.
 *
 * A *survivor* at the stamp still ties, and the sweep refuses the placement outright rather than
 * reason about which way the tie falls — see {@link sweepStockDeltas}. The tie is harmless for a
 * movement and unsafe for an assertion, and the rule is not worth splitting for the sake of one
 * millisecond a day.
 */
function checkpointStamp(cutoff: number): number {
  return cutoff - 1;
}

/**
 * The placements worth compacting: those holding **two or more** rows older than the stamp.
 *
 * The threshold is what stops the sweep churning. A placement whose expired era is already a single
 * row — the checkpoint a previous sweep left — has nothing to save by being rewritten, and
 * rewriting it would mint a *new* id at the newer cutoff every pass, so each sync would push a
 * changed ledger and every peer would union in another dead checkpoint.
 */
async function expiredPlacements(driver: IDatabaseDriver, stamp: number): Promise<PlacementKey[]> {
  const rows = await driver.query<{ item_id: string; location_id: string; batch_key: string }>(
    `SELECT item_id, location_id, batch_key
       FROM stock_deltas
      WHERE created_at < ?
      GROUP BY item_id, location_id, batch_key
     HAVING COUNT(*) >= 2
      ORDER BY item_id, location_id, batch_key;`,
    [stamp],
  );
  return rows.map((r) => ({
    itemId: String(r.item_id),
    locationId: String(r.location_id),
    batchKey: String(r.batch_key),
  }));
}

/** One placement's whole ledger, plus the quantity the checkpoint has to be able to explain. */
interface PlacementLedger {
  readonly deltas: StockQuantityDelta[];
  /** `undefined` when the placement has no `stock_batches` row at all. */
  readonly quantity: number | undefined;
}

/** Read every delta of `key`, projected for the replay, beside its stored quantity. */
async function readPlacement(driver: IDatabaseDriver, key: PlacementKey): Promise<PlacementLedger> {
  const rows = await driver.query<SqlRow>(
    `SELECT id, quantity_delta, created_at, asserted_quantity
       FROM stock_deltas
      WHERE item_id = ? AND location_id = ? AND batch_key = ?;`,
    [key.itemId, key.locationId, key.batchKey],
  );
  const batch = await driver.queryOne<{ quantity: number }>(
    `SELECT quantity FROM stock_batches
      WHERE item_id = ? AND location_id = ? AND batch_key = ?;`,
    [key.itemId, key.locationId, key.batchKey],
  );
  return {
    deltas: rows.map(toDelta),
    quantity: batch === undefined ? undefined : num(batch.quantity),
  };
}

/**
 * Replace one placement's era with its checkpoint, atomically.
 *
 * The delete names the era's rows by **id** rather than repeating the `created_at` predicate, so a
 * row captured between the read and the write is never swept up in a summary that did not account
 * for it.
 *
 * `INSERT OR REPLACE` because a peer's copy of this very checkpoint may already have unioned in and
 * be part of the era being summarised — the same id, the same figures, written once.
 */
function compactStatements(
  key: PlacementKey,
  era: readonly StockQuantityDelta[],
  summary: EraSummary,
  id: string,
  stamp: number,
): SqlStatement[] {
  return [
    ...era.map((d) => ({
      sql: `DELETE FROM ${STOCK_DELTAS_TABLE} WHERE id = ?;`,
      params: [d.id],
    })),
    {
      sql: `INSERT OR REPLACE INTO ${STOCK_DELTAS_TABLE}
              (id, item_id, location_id, batch_key, quantity_delta, created_at, asserted_quantity)
            VALUES (?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        key.itemId,
        key.locationId,
        key.batchKey,
        summary.netDelta,
        stamp,
        summary.assertedQuantity,
      ],
    },
  ];
}

/**
 * Run both sweeps: prune the orphans, then summarise every expired era into its checkpoint.
 *
 * `cutoff` is in **this device's clock frame** — see `stockDeltaCompactionCutoff` in
 * `./retention` for why that distinction matters.
 *
 * **Deliberately ungated** (issue #429). This is System-actor housekeeping over a convergence
 * ledger, not a user action: it summarises expired eras into checkpoints so the ledger stops
 * growing, and it is called only from `runSnapshotMerge` — inside the database worker, where
 * there is no session to resolve an authority from. Refusing it would leave the ledger to grow
 * without bound for exactly the sessions least able to do anything about it.
 */
export async function sweepStockDeltas(
  driver: IDatabaseDriver,
  cutoff: number,
): Promise<StockDeltaSweepResult> {
  const orphansPruned = await pruneOrphans(driver);

  let erasCompacted = 0;
  let placementsCompacted = 0;
  // One commit per placement would be thousands of `BEGIN…COMMIT` pairs on the first sweep of a
  // long-lived database, each with its own OPFS flush. Batching is safe because a placement's
  // statements are contiguous and self-contained: every flush boundary falls between placements,
  // so a batch that fails rolls back whole placements and the next sweep simply redoes them.
  let batch: SqlStatement[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await driver.transaction(batch);
    batch = [];
  };

  const stamp = checkpointStamp(cutoff);
  for (const key of await expiredPlacements(driver, stamp)) {
    const { deltas, quantity } = await readPlacement(driver, key);
    // The completeness gate, and the reason the whole ledger is read rather than just the era.
    // A checkpoint is an **assertion**, and an assertion is authoritative wherever it lands: the
    // replay restarts from it, and every peer that unions it in adopts it as their base. So it may
    // only be minted from a ledger that demonstrably explains its own placement — the same
    // `replay(deltas) == stock_batches.quantity` test `reconcileStock` applies before it will trust
    // a replay. A *baseline-less* placement fails it: a history-excluded backup restores the
    // quantities with `stockDeltas = []`, so the movements recorded afterwards replay to a figure
    // short by the whole missing base. Summarising those into an assertion would state that short
    // figure as fact and destroy the correct base on every peer that still holds it —
    // unrecoverably, because the peer's own sweep then derives the same id and rewrites its own
    // history to match. Such a placement is left uncompacted: it is already on Last-Write-Wins
    // locally, and it stays merely incomplete rather than becoming authoritatively wrong.
    if (quantity === undefined) continue;
    if (replayStockQuantity(deltas) !== quantity) continue;
    // Nothing may already occupy the instant the checkpoint is about to claim. A *movement* there
    // would be harmless — the replay orders an assertion before a movement at equal `createdAt`, so
    // it would simply apply on top — but an **assertion** there ties on rank as well, leaving only
    // the id to separate them. The checkpoint's derived UUID has no ordering relationship to a
    // capture trigger's `randomblob` id, so a cycle count stamped in that one millisecond would be
    // superseded by the checkpoint on a coin-flip, asserting a total that predates the count. The
    // placement is left for the next sweep, whose stamp falls on a different instant.
    if (deltas.some((d) => d.createdAt === stamp)) continue;
    const era = deltas.filter((d) => d.createdAt < stamp);
    // The grouping query already excluded a one-row era; a concurrent delete could still have
    // reduced one, and rewriting that single row under a new id is the churn the threshold exists
    // to avoid.
    if (era.length < 2) continue;
    const id = await checkpointId(key, cutoff);
    batch.push(...compactStatements(key, era, summariseEra(era), id, stamp));
    erasCompacted += era.length;
    placementsCompacted += 1;
    if (batch.length >= COMPACTION_BATCH_STATEMENTS) await flush();
  }
  await flush();

  return { orphansPruned, erasCompacted, placementsCompacted };
}
