/**
 * Batch-level stock ledger SQL builders (spec §4 perishables & traceability, Phase 28).
 *
 * `stock_batches` is the SSOT one level below `item_stock` (Phase 25): one row per
 * `(item, location, batch identity)`, keyed by the deterministic
 * `${itemId}|${locationId}|${batchKey}` id so two devices recording the same lot at the
 * same placement generate the same row and merge by LWW. The `trg_stock_batches_recompute_*`
 * triggers keep `item_stock.quantity = SUM(stock_batches.quantity)` per placement, which then
 * chains into the v13 triggers maintaining `items.quantity` — so these builders only ever
 * touch the batch ledger and both projections follow automatically.
 *
 * Increments target a specific batch (the untracked remainder is just the empty-key default
 * batch); a placement *decrement* spans batches first-expiry-first-out via the pure
 * {@link planBatchConsumption} in `features/inventory/batches.ts`, whose plan
 * {@link consumeBatchStatements} turns into per-row decrements. Emptied batches are set to 0,
 * never deleted, so a removal propagates by row-level LWW (mirroring `item_stock`).
 */
import type { IDatabaseDriver, SqlStatement } from '../rpc/driver';
import {
  batchKeyOf,
  planBatchConsumption,
  type BatchIdentity,
  type BatchLine,
  type ConsumptionPlan,
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
