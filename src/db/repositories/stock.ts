/**
 * Per-location stock ledger SQL builders (spec §4, Phase 25; batch-aware Phase 28).
 *
 * `item_stock` records *where* an item's units sit — one row per (item, location), keyed by
 * the deterministic `${itemId}|${locationId}` id. Since Phase 28 it is itself a derived
 * projection: `item_stock.quantity = SUM(stock_batches.quantity)` for that placement,
 * maintained by the `trg_stock_batches_recompute_*` triggers (which then chain into the v13
 * triggers maintaining `items.quantity`). So these builders no longer write `item_stock`
 * directly — they write the placement's **default (untracked) batch** in `stock_batches`, and
 * both projections follow automatically. Batch-aware callers (receiving a specific lot, FEFO
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
