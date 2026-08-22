/**
 * Batch-level stock ledger SQL builders (spec §4 perishables & traceability, Phase 28).
 *
 * `stock_batches` is the SSOT one level below `item_stock` (Phase 25): one row per
 * `(item, location, batch identity)`, keyed by the deterministic
 * `${itemId}|${locationId}|${batchKey}` id so two devices recording the same lot at the
 * same placement generate the same row and merge by LWW. The `trg_stock_batches_recompute_*`
 * triggers keep `item_stock.quantity = SUM(stock_batches.quantity)` per placement, which then
 * chains into the `trg_item_stock_recompute_*` triggers maintaining `items.quantity` — so these
 * builders only ever touch the batch ledger and both projections follow automatically.
 *
 * Increments target a specific batch (the untracked remainder is just the empty-key default
 * batch); a placement *decrement* spans batches first-expiry-first-out via the pure
 * {@link planBatchConsumption} in `features/inventory/batches.ts`, whose plan
 * {@link consumeBatchStatements} turns into per-row decrements. Emptied batches are set to 0,
 * never deleted, so a removal propagates by row-level LWW (mirroring `item_stock`).
 */
import { DbError } from '../errors';
import type { IDatabaseDriver, SqlStatement } from '../rpc/driver';
import {
  batchKeyOf,
  planBatchConsumption,
  planItemConsumption,
  type BatchIdentity,
  type BatchLine,
  type ConsumptionPlan,
  type LocatedBatchLine,
} from '@/features/inventory/batches';

/** Deterministic separator between the item, location and batch-key segments. */
const SEP = '|';

/** The composite ledger-row id for a batch placement (item/location UUIDs contain no `|`). */
export function stockBatchRowId(itemId: string, locationId: string, batchKey: string): string {
  return `${itemId}${SEP}${locationId}${SEP}${batchKey}`;
}

/** The empty (all-null) batch identity — the untracked default batch. */
export const UNTRACKED_BATCH: BatchIdentity = { batchNumber: null, lotNumber: null, expiryDate: null };

/**
 * Upsert a batch row to an **absolute** quantity. The identity columns are written only on
 * insert (a batch's identity is fixed by its key); a conflict updates the quantity alone.
 */
export function setBatchStatement(
  itemId: string,
  locationId: string,
  identity: BatchIdentity,
  quantity: number,
): SqlStatement {
  const key = batchKeyOf(identity);
  return {
    sql: `INSERT INTO stock_batches
            (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity;`,
    params: [
      stockBatchRowId(itemId, locationId, key),
      itemId,
      locationId,
      key,
      identity.batchNumber,
      identity.lotNumber,
      identity.expiryDate,
      quantity,
    ],
  };
}

/**
 * Grow (or create) a batch row by a **non-negative** `amount` — the receive/transfer-in side.
 * A negative amount would trip `CHECK (quantity >= 0)` on the inserted VALUES *before* the
 * conflict resolution, so use a {@link consumeBatchStatements} plan to decrement instead.
 */
export function addBatchStatement(
  itemId: string,
  locationId: string,
  identity: BatchIdentity,
  amount: number,
): SqlStatement {
  const key = batchKeyOf(identity);
  return {
    sql: `INSERT INTO stock_batches
            (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET quantity = stock_batches.quantity + excluded.quantity;`,
    params: [
      stockBatchRowId(itemId, locationId, key),
      itemId,
      locationId,
      key,
      identity.batchNumber,
      identity.lotNumber,
      identity.expiryDate,
      amount,
    ],
  };
}

/**
 * Turn a FEFO {@link planBatchConsumption} plan into per-batch decrements (plain UPDATEs, so a
 * decrement is fine — only the post-update quantity is CHECK-tested). Each targeted batch row
 * must exist; the plan is built from the placement's current rows, so it always does.
 */
export function consumeBatchStatements(
  itemId: string,
  locationId: string,
  plan: ConsumptionPlan,
): SqlStatement[] {
  return plan.consumed.map((c) => ({
    sql: `UPDATE stock_batches SET quantity = quantity - ? WHERE id = ?;`,
    params: [c.amount, stockBatchRowId(itemId, locationId, c.batchKey)],
  }));
}

/**
 * Bracket a batch of statements so the `stock_batches` capture triggers record their deltas as
 * **absolute assertions** rather than relative movements (issue #633).
 *
 * A cycle count states what is physically there — "8 in this drawer" — but reaches the ledger as
 * the correction it happens to imply (`−2`). Summing the id-union of those corrections is right for
 * two genuine movements and wrong for one count performed twice: counting the same drawer on two
 * devices before they sync applies both `−2`s, converging on a figure neither counter ever saw.
 * Inside this bracket each captured delta also records the quantity the write left behind, which
 * the reconcile replay takes as its base instead of adding it to what came before — so a second
 * identical count is the no-op an absolute count is by definition.
 *
 * The mirror image of `withCaptureDisabled` in `features/sync/snapshot.ts`, and flipped the
 * same way: inside the caller's own transaction, so a rollback restores the switch with it. Only
 * wraps a non-empty batch, and must wrap **only** the count's own `stock_batches` writes — any
 * ordinary movement caught inside would be mis-recorded as something physically observed.
 */
export function withAssertedCount(statements: readonly SqlStatement[]): SqlStatement[] {
  if (statements.length === 0) return [...statements];
  return [
    { sql: 'UPDATE stock_delta_capture SET asserting = 1 WHERE id = 1;' },
    ...statements,
    { sql: 'UPDATE stock_delta_capture SET asserting = 0 WHERE id = 1;' },
  ];
}

/** The canonical UUID shape an operation key must take — see {@link withOperationKey}. */
const OPERATION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bracket a batch of statements so the `stock_batches` capture triggers give their deltas ids
 * **derived from `key`** rather than random ones (issue #696).
 *
 * A one-shot terminal operation — finalising a project's assembly — can be run once on each of two
 * devices while they are offline. Issue #195 already derives every row such a finalise mints from
 * the project id, so the merge collapses the two runs to one container, one assembled item and one
 * ledger entry per part. The stock it moved had no equivalent: each device's copy of the same draw
 * carried its own random delta id, so the id-union replay in `reconcileStockQuantity` read the two
 * copies as two movements and took the quantity twice, silently and unrecoverably.
 *
 * Inside this bracket both devices derive the same ids for the same draw, so the union sees one
 * movement — the convergence #195 gives the operation's rows, extended to the stock it moves.
 *
 * `key` must be a **canonical lower-case UUID derived from the operation's own stable identity**
 * (`assemblyId('stock', projectId)`, say) — never `crypto.randomUUID()`, which would defeat the
 * whole point, and never a value that could carry `|`, `%` or `_` (the derivation's own separator
 * and the `LIKE` wildcards its ordinal counts by). The shape is checked here and by a CHECK on the
 * column, because a key that slipped through would mint ids that collide or miscount rather than
 * failing loudly.
 *
 * Bracketed like {@link withAssertedCount} and `withCaptureDisabled`: inside the caller's own
 * transaction, so a rollback restores the switch with it. Wrap **only** the one operation's own
 * writes — any unrelated movement caught inside would take an id derived from an operation it was
 * no part of.
 */
export function withOperationKey(key: string, statements: readonly SqlStatement[]): SqlStatement[] {
  if (!OPERATION_KEY_PATTERN.test(key)) {
    throw new DbError('SQLITE_ERROR', `Operation key must be a canonical lower-case UUID: ${key}`);
  }
  if (statements.length === 0) return [...statements];
  return [
    { sql: 'UPDATE stock_delta_capture SET operation_key = ? WHERE id = 1;', params: [key] },
    ...statements,
    { sql: 'UPDATE stock_delta_capture SET operation_key = NULL WHERE id = 1;' },
  ];
}

/**
 * The default user-facing sentence for a lost stock race — see {@link runStockDraw}.
 */
export const STOCK_DRAW_RACE_MESSAGE =
  'Not enough stock left to make that change — the quantity changed while this was being saved. ' +
  'Check the current amount and try again.';

/**
 * True when `error` is the `quantity >= 0` CHECK backstop firing.
 *
 * Every quantity column in the ledger (`stock_batches` → `item_stock` → `items`) carries the
 * same unnamed `CHECK (quantity >= 0)`, and the recompute triggers chain them, so whichever of
 * the three trips first means exactly one thing: the write would have taken stock negative.
 * Pure and message-based because SQLite reports an unnamed CHECK by its expression text.
 *
 * Deliberately keyed on the message alone, **not** on `error.code`: the three drivers disagree
 * on the code for the very same failure. `node:sqlite` (the test and bridge drivers) exposes the
 * result code as `errcode`, which `DbError.fromUnknown` does not read, so it lands as
 * `TRANSACTION_FAILED`; sqlite-wasm in the worker falls back to `UNKNOWN` when it carries no
 * `resultCode`. Gating on a code set would silently miss in the browser — the one path a user
 * actually sees. The message is the specific signal, so it is the one to match.
 */
export function isQuantityFloorViolation(error: unknown): boolean {
  if (!(error instanceof DbError)) return false;
  return /CHECK constraint failed:\s*quantity >= 0/i.test(error.message);
}

/**
 * Run a transaction that draws stock **down**, translating the `quantity >= 0` backstop into a
 * graceful validation error (issue #302).
 *
 * Availability is validated by a read taken *before* the transaction, so two overlapping
 * decrements (a double-tapped stepper, two devices, a blur committing behind an in-flight tap)
 * can both plan against the same on-hand and the loser trips the CHECK. The constraint is the
 * correct backstop — it is what keeps the ledger honest — but a raw
 * `CHECK constraint failed: quantity >= 0` is not something to show a user. Every drawdown
 * routes through here so the loser gets the same plain sentence instead, and the caller's
 * optimistic update rolls back exactly as it would for any other rejection.
 */
export async function runStockDraw(
  driver: IDatabaseDriver,
  statements: SqlStatement[],
  message: string = STOCK_DRAW_RACE_MESSAGE,
): Promise<void> {
  try {
    await driver.transaction(statements);
  } catch (error) {
    if (isQuantityFloorViolation(error)) {
      throw new DbError('SQLITE_CONSTRAINT', message, { cause: error });
    }
    throw error;
  }
}

/** Map a `stock_batches` row to the pure {@link BatchLine} the planner/UI consume. */
export function rowToBatchLine(row: {
  batch_key: string;
  batch_number: string | null;
  lot_number: string | null;
  expiry_date: number | null;
  quantity: number;
}): BatchLine {
  return {
    batchKey: row.batch_key,
    batchNumber: row.batch_number,
    lotNumber: row.lot_number,
    expiryDate: row.expiry_date,
    quantity: Number(row.quantity),
  };
}

/**
 * Read a placement's batch rows (those actually holding stock) as pure {@link BatchLine}s,
 * for the FEFO consumption planner and the breakdown UI. A driver read, not a builder, so it
 * is shared by every repository that needs the placement's batch composition.
 */
export async function readPlacementBatches(
  driver: IDatabaseDriver,
  itemId: string,
  locationId: string,
): Promise<BatchLine[]> {
  const rows = await driver.query<{
    batch_key: string;
    batch_number: string | null;
    lot_number: string | null;
    expiry_date: number | null;
    quantity: number;
  }>(
    `SELECT batch_key, batch_number, lot_number, expiry_date, quantity
     FROM stock_batches WHERE item_id = ? AND location_id = ? AND quantity > 0;`,
    [itemId, locationId],
  );
  return rows.map(rowToBatchLine);
}

/**
 * Build the statements to adjust a placement by a signed `delta`, batch-aware: a positive
 * delta grows the **default (untracked) batch** (the found units have no known lot); a
 * negative delta is drawn down **first-expiry-first-out** across the placement's batches via
 * {@link planBatchConsumption}. The single seam every whole-placement quantity write (an
 * adjustment, a reconcile variance, a checkout) routes through, so all of them stay
 * batch-consistent. The caller is responsible for having validated availability (the
 * `CHECK (quantity >= 0)` is the backstop); a shortfall leaves the deficit unconsumed.
 */
export async function placementDeltaStatements(
  driver: IDatabaseDriver,
  itemId: string,
  locationId: string,
  delta: number,
): Promise<SqlStatement[]> {
  if (delta === 0) return [];
  if (delta > 0) return [addBatchStatement(itemId, locationId, UNTRACKED_BATCH, delta)];
  const batches = await readPlacementBatches(driver, itemId, locationId);
  return consumeBatchStatements(itemId, locationId, planBatchConsumption(batches, -delta));
}

/**
 * Read an item's *whole-ledger* batch composition — every `(location, batch)` row holding stock,
 * across all its placements — as located batch lines for a cross-location FEFO draw (Kits v3).
 */
export async function readItemBatches(driver: IDatabaseDriver, itemId: string): Promise<LocatedBatchLine[]> {
  const rows = await driver.query<{
    location_id: string;
    batch_key: string;
    batch_number: string | null;
    lot_number: string | null;
    expiry_date: number | null;
    quantity: number;
  }>(
    `SELECT location_id, batch_key, batch_number, lot_number, expiry_date, quantity
     FROM stock_batches WHERE item_id = ? AND quantity > 0;`,
    [itemId],
  );
  return rows.map((r) => ({ ...rowToBatchLine(r), locationId: r.location_id }));
}

/**
 * Build the statements to consume `amount` units of an item **first-expiry-first-out across every
 * location it sits in** (Kits v3) — so a kit assembly draws from the item's whole on-hand grand
 * total, not just its home placement. The plan is built from the item's current batch rows via the
 * pure {@link planItemConsumption}; any shortfall leaves the deficit unconsumed (the caller must
 * validate availability first, with the `CHECK (quantity >= 0)` as the backstop). Consuming zero
 * yields no statements.
 */
export async function itemConsumeStatements(
  driver: IDatabaseDriver,
  itemId: string,
  amount: number,
): Promise<SqlStatement[]> {
  if (amount <= 0) return [];
  const batches = await readItemBatches(driver, itemId);
  const plan = planItemConsumption(batches, amount);
  return plan.consumed.map((c) => ({
    sql: `UPDATE stock_batches SET quantity = quantity - ? WHERE id = ?;`,
    params: [c.amount, stockBatchRowId(itemId, c.locationId, c.batchKey)],
  }));
}

/**
 * Build the statements to move `amount` units of an item **into** `toLocationId`, drawn
 * first-expiry-first-out across every location it currently sits in and re-landed under the
 * *same* lot identity (issue #647) — a **partial** whole-item move, where `stock.ts`'s
 * `consolidateStockStatements` moves everything.
 *
 * Each slice becomes a decrement of its source row paired with an increment of the matching
 * batch at the destination, so a lot never loses its batch/expiry identity by being moved. Slices
 * already sitting at the destination net to zero (the decrement and the increment address the
 * same row id) — units that are already there are already gathered, so the move leaves them
 * alone rather than double-counting them. Availability is the caller's to validate, exactly as
 * for {@link itemConsumeStatements}: any shortfall simply leaves the deficit unmoved.
 */
export async function itemMoveStatements(
  driver: IDatabaseDriver,
  itemId: string,
  amount: number,
  toLocationId: string,
): Promise<SqlStatement[]> {
  if (amount <= 0) return [];
  const batches = await readItemBatches(driver, itemId);
  const plan = planItemConsumption(batches, amount);
  const statements: SqlStatement[] = [];
  for (const slice of plan.consumed) {
    const source = batches.find((b) => b.locationId === slice.locationId && b.batchKey === slice.batchKey);
    // Non-null in practice — the plan is built from these very rows — but a missing line would
    // mean taking stock out with nowhere to put it, so skip rather than lose the units.
    if (!source) continue;
    statements.push(
      {
        sql: `UPDATE stock_batches SET quantity = quantity - ? WHERE id = ?;`,
        params: [slice.amount, stockBatchRowId(itemId, slice.locationId, slice.batchKey)],
      },
      addBatchStatement(
        itemId,
        toLocationId,
        {
          batchNumber: source.batchNumber,
          lotNumber: source.lotNumber,
          expiryDate: source.expiryDate,
        },
        slice.amount,
      ),
    );
  }
  return statements;
}
