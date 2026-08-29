/**
 * Per-location stock ledger SQL builders (spec §4, Phase 25; batch-aware Phase 28).
 *
 * `item_stock` records *where* an item's units sit — one row per (item, location), keyed by
 * the deterministic `${itemId}|${locationId}` id. Since Phase 28 it is itself a derived
 * projection: `item_stock.quantity = SUM(stock_batches.quantity)` for that placement,
 * maintained by the `trg_stock_batches_recompute_*` triggers (which then chain into the
 * `trg_item_stock_recompute_*` triggers maintaining `items.quantity`). So these builders no
 * longer write `item_stock` directly — they write the placement's **default (untracked) batch**
 * in `stock_batches`, and both projections follow automatically. Batch-aware callers (receiving a specific lot, FEFO
 * consumption) use the `stock-batches.ts` builders directly.
 *
 * Emptied batches are set to 0, never deleted, so a removal propagates by row-level LWW.
 */
import type { SqlStatement } from '../rpc/driver';
import { addBatchStatement, setBatchStatement, UNTRACKED_BATCH } from './stock-batches';

/** Deterministic, collision-free separator between the item and location ids. */
const STOCK_ID_SEP = '|';

/** The composite `item_stock` row id for a placement (a UUID can never contain `|`). */
export function stockRowId(itemId: string, locationId: string): string {
  return `${itemId}${STOCK_ID_SEP}${locationId}`;
}

/**
 * Seed/overwrite a placement to an absolute quantity by setting its **default (untracked)
 * batch** — the create-seed / variant-seed path, where no tracked batches exist yet. The
 * recompute triggers re-derive `item_stock.quantity` (and `items.quantity`) from the batch.
 */
export function setStockStatement(itemId: string, locationId: string, quantity: number): SqlStatement {
  return setBatchStatement(itemId, locationId, UNTRACKED_BATCH, quantity);
}

/**
 * Grow (or create) a placement's **default (untracked) batch** by a non-negative `amount` —
 * the create-or-add side of a transfer-in / whole-item receipt without a specific lot.
 */
export function addStockStatement(itemId: string, locationId: string, amount: number): SqlStatement {
  return addBatchStatement(itemId, locationId, UNTRACKED_BATCH, amount);
}

/**
 * The set-based re-derivation of the stock projection, run once at the end of a batch whose
 * per-statement recompute was suppressed (issue #548).
 *
 * Each statement is the set-based twin of the recompute trigger it stands in for, carrying the
 * same `quantity <> (SELECT SUM(...))` guard — so a placement or an item whose stored total already
 * equals its ledger is not written at all, and its `updated_at` survives untouched. Where a total
 * genuinely differs the row is written, the auto-stamp trigger stamps it exactly as any local stock
 * change is stamped, and the correction propagates on the next sync.
 *
 * The `EXISTS` guards keep the sweep to placements and items the ledger actually speaks for, which
 * is what a trigger does implicitly by only firing on a write. Without them a snapshot that carries
 * `item_stock` but no `stock_batches` — a foreign or hand-edited file — would have every one of its
 * placements zeroed by a sweep that the triggers would never have run.
 *
 * `itemId` narrows the sweep to one item, for a caller deferring the recompute over a handful of
 * statements rather than a whole restore ({@link moveWholeItemStatements}). A whole-database sweep
 * on every such write would be a table scan of the entire inventory to settle one row.
 */
export function settleStockProjectionStatements(itemId?: string): SqlStatement[] {
  const batchSum = `(SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                      WHERE item_id = item_stock.item_id AND location_id = item_stock.location_id)`;
  const placementSum = `(SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = items.id)`;
  const one = itemId !== undefined;
  return [
    // A placement the ledger carries batches for but no `item_stock` row: the insert arm of
    // `trg_stock_batches_recompute_ins`. Matched on the natural key rather than the derived id,
    // because a foreign snapshot's `item_stock.id` need not follow the `item|location` form.
    {
      sql: `INSERT INTO item_stock (id, item_id, location_id, quantity)
            SELECT b.item_id || '|' || b.location_id, b.item_id, b.location_id, SUM(b.quantity)
              FROM stock_batches b
             WHERE ${one ? 'b.item_id = ? AND ' : ''}NOT EXISTS (SELECT 1 FROM item_stock s
                                WHERE s.item_id = b.item_id AND s.location_id = b.location_id)
             GROUP BY b.item_id, b.location_id;`,
      params: one ? [itemId] : undefined,
    },
    {
      sql: `UPDATE item_stock SET quantity = ${batchSum}
             WHERE ${one ? 'item_id = ? AND ' : ''}EXISTS (SELECT 1 FROM stock_batches b
                            WHERE b.item_id = item_stock.item_id AND b.location_id = item_stock.location_id)
               AND quantity <> ${batchSum};`,
      params: one ? [itemId] : undefined,
    },
    {
      sql: `UPDATE items SET quantity = ${placementSum}
             WHERE ${one ? 'id = ? AND ' : ''}EXISTS (SELECT 1 FROM item_stock s WHERE s.item_id = items.id)
               AND quantity <> ${placementSum};`,
      params: one ? [itemId] : undefined,
    },
  ];
}

/**
 * Move an item **wholesale** to another location: every placement consolidated into the target,
 * and the item's own `location_id` following.
 *
 * The consolidation is bracketed so the derived-quantity triggers stay dormant while it runs, and
 * the projection is settled once from the finished ledger. That is not an optimisation — it is
 * what makes the move legal at all for a SERIALISED instance (issue #640). `items.quantity` is
 * `SUM(item_stock)`, and the two statements that empty one placement and fill another are
 * necessarily two writes, so a per-statement recompute walks the total through 2 (fill first) or 0
 * (empty first). Either breaches `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` and aborts
 * the whole transaction — so before this, moving a serialised unit anywhere failed outright,
 * whichever caller asked. Deferring the recompute means the total is only ever written once, at
 * the value it ends on, which for a move is the value it started at.
 *
 * The **capture** triggers are untouched by the bracket, so the convergence ledger still records
 * the move as it always did: `+n` at the target placement and `-n` at the one it left.
 */
export function moveWholeItemStatements(itemId: string, toLocationId: string): SqlStatement[] {
  return [
    { sql: 'UPDATE stock_delta_capture SET recompute = 0 WHERE id = 1;' },
    ...consolidateStockStatements(itemId, toLocationId),
    ...settleStockProjectionStatements(itemId),
    { sql: 'UPDATE stock_delta_capture SET recompute = 1 WHERE id = 1;' },
    { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [toLocationId, itemId] },
  ];
}

/**
 * Consolidate every batch of an item into one location, preserving each lot's identity — the
 * write behind a whole-item "move". Same-key batches at different source locations merge into
 * the target placement's row (so two drawers' worth of lot A become one), and every moved-from
 * batch is zeroed (kept, not deleted, so the emptying syncs by LWW). Works for a single- or
 * multi-location, single- or multi-batch item.
 */
export function consolidateStockStatements(itemId: string, toLocationId: string): SqlStatement[] {
  return [
    {
      // Roll every non-target-location batch (grouped by key, so duplicate keys pre-aggregate)
      // into the matching target-location batch row, preserving its identity columns.
      sql: `INSERT INTO stock_batches
              (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
            SELECT item_id || '|' || ? || '|' || batch_key, item_id, ?, batch_key,
                   MAX(batch_number), MAX(lot_number), expiry_date, SUM(quantity)
            FROM stock_batches
            WHERE item_id = ? AND location_id <> ? AND quantity > 0
            GROUP BY batch_key, expiry_date
            ON CONFLICT(id) DO UPDATE SET quantity = stock_batches.quantity + excluded.quantity;`,
      params: [toLocationId, toLocationId, itemId, toLocationId],
    },
    {
      sql: `UPDATE stock_batches SET quantity = 0
            WHERE item_id = ? AND location_id <> ? AND quantity <> 0;`,
      params: [itemId, toLocationId],
    },
  ];
}
