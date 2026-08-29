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
    ...serialisedPlacementRepairStatements(itemId),
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
 * Bring every SERIALISED item's placements back to the one the schema insists on: exactly one
 * unit, at the location the item itself names (issue #640).
 *
 * A serialised record *is* one physical thing, and `CHECK (tracking_mode <> 'SERIALISED' OR
 * quantity = 1)` says so. Nothing enforces *where* that one unit sits, though, and two devices
 * counting the same week can legitimately reach different answers: one finds the multimeter in
 * the garage and relocates it there, the other finds it on the bench. Sync unions the ledger by
 * row, so both placements arrive holding one unit, the projection sums them to two, and the CHECK
 * aborts — not with a wrong number that later heals, but with a merge that fails again on every
 * attempt until somebody edits the database by hand.
 *
 * `items.location_id` is the arbiter, because it is a single column on a row that already
 * converges by last-write-wins — so the two devices agree on where the unit is *before* this runs,
 * and this only makes the placement ledger say the same thing. The later count wins, which is the
 * same rule a disagreement between two counts of a lot settles by.
 *
 * Applied only to an item the placement ledger already speaks for, in the spirit of the `EXISTS`
 * guards below: a snapshot that carries `items` but no `stock_batches` at all is not asserting
 * that its serialised units are homeless, and fabricating placements for them would be this
 * function inventing stock rather than reconciling it. An item with *any* batch row is fair game,
 * including one whose home placement has no row yet — that is the divergence above, mid-repair.
 *
 * Deliberately not filtered on `is_active`: the CHECK is unconditional, so a soft-deleted
 * instance still holds its one unit and still needs somewhere to hold it.
 */
function serialisedPlacementRepairStatements(itemId?: string): SqlStatement[] {
  const one = itemId !== undefined;
  return [
    {
      // Every row but the one it belongs in: emptied, not deleted, so the correction travels by
      // row-level LWW.
      //
      // Unlike every other emptying in this ledger, it is **not** captured as a movement on the
      // merge and restore paths, because those run the whole apply inside `withCaptureDisabled` —
      // so for every placement a repair touches, `stock_batches.quantity == Σ stock_deltas` stops
      // holding. `sideIsComplete` (`features/sync/reconcile.ts`) then declines to replay those
      // placements and settles them by last-write-wins instead, and `stock-delta-compaction`
      // leaves their rows uncompacted.
      //
      // That is the right trade here rather than an oversight. A serialised item's *total* is
      // pinned at 1 by `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` on `items`, and it
      // has one placement, so there is no arithmetic for the delta CRDT to protect: *where* the
      // unit is, is decided by `items.location_id`, which last-write-wins already settles
      // correctly and is what this repair reads. Writing deltas by hand to keep the sum tidy would
      // put a fabricated movement in an append-only ledger the capture triggers are the sole
      // author of — describing a unit moving that nobody moved.
      //
      // "The one it belongs in" is the **untracked** batch at the item's own location, because a
      // serialised instance is only ever seeded with that one — its lot identity lives on the
      // `items` row's own `batch_number` / `lot_number` / `expiry_date` columns, not on a tracked
      // placement. So a tracked row against a serialised item can only arrive from a foreign or
      // hand-edited snapshot, and leaving it beside the untracked row the next statement writes
      // would total two.
      sql: `UPDATE stock_batches SET quantity = 0
             WHERE ${one ? 'item_id = ? AND ' : ''}quantity <> 0
               AND EXISTS (SELECT 1 FROM items i
                            WHERE i.id = stock_batches.item_id
                              AND i.tracking_mode = 'SERIALISED'
                              AND (i.location_id <> stock_batches.location_id
                                   OR stock_batches.batch_key <> ''));`,
      params: one ? [itemId] : undefined,
    },
    {
      // …and exactly one unit where it is, in the untracked batch a serialised instance is
      // created with.
      sql: `UPDATE stock_batches SET quantity = 1
             WHERE ${one ? 'item_id = ? AND ' : ''}batch_key = '' AND quantity <> 1
               AND EXISTS (SELECT 1 FROM items i
                            WHERE i.id = stock_batches.item_id
                              AND i.tracking_mode = 'SERIALISED'
                              AND i.location_id = stock_batches.location_id);`,
      params: one ? [itemId] : undefined,
    },
    {
      // A foreign row already sitting on the id the seed below would write, rewritten into the
      // home placement rather than collided with.
      //
      // Both halves of that matter, because a `stock_batches.id` is only *by convention*
      // `item|location|batch`: the snapshot and merge applies write whatever id the incoming file
      // carries. So the home row has to be found by its **natural** key — the reason the
      // `item_stock` arm below gives for the same choice — and the seed's own derived id has to
      // survive meeting a row that already holds it. Either mistake ends the same way: a
      // constraint failure that aborts every restore, merge, move and location delete touching
      // that item, permanently. Which is the failure this whole function exists to prevent.
      //
      // Only reachable when there is no home row under the natural key, so the row being rewritten
      // cannot be colliding with one; and the id it holds already names this placement, so the
      // rewrite is the row being made to agree with itself.
      sql: `UPDATE stock_batches
               SET location_id = (SELECT i.location_id FROM items i WHERE i.id = stock_batches.item_id),
                   batch_key = '', batch_number = NULL, lot_number = NULL, expiry_date = NULL,
                   quantity = 1
             WHERE ${one ? 'item_id = ? AND ' : ''}EXISTS (
                     SELECT 1 FROM items i
                      WHERE i.id = stock_batches.item_id
                        AND i.tracking_mode = 'SERIALISED'
                        AND stock_batches.id = i.id || '|' || i.location_id || '|'
                        AND NOT EXISTS (SELECT 1 FROM stock_batches b
                                         WHERE b.item_id = i.id AND b.location_id = i.location_id
                                           AND b.batch_key = ''));`,
      params: one ? [itemId] : undefined,
    },
    {
      // Seeding the home row when there is still none — the other half of a diverged pair, once
      // the first statement has emptied what this device had.
      sql: `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity)
            SELECT i.id || '|' || i.location_id || '|', i.id, i.location_id, '', 1
              FROM items i
             WHERE ${one ? 'i.id = ? AND ' : ''}i.tracking_mode = 'SERIALISED'
               AND EXISTS (SELECT 1 FROM stock_batches b WHERE b.item_id = i.id)
               AND NOT EXISTS (SELECT 1 FROM stock_batches b
                                WHERE b.item_id = i.id AND b.location_id = i.location_id
                                  AND b.batch_key = '');`,
      params: one ? [itemId] : undefined,
    },
  ];
}

/**
 * Move an item **wholesale** to another location: every placement consolidated into the target,
 * and the item's own `location_id` following.
 *
 * The consolidation runs inside {@link withRecomputeDeferred}, so the derived-quantity triggers
 * stay dormant while it runs and the projection is settled once from the finished ledger. That is
 * not an optimisation — it is what makes the move legal at all for a SERIALISED instance
 * (issue #640). `items.quantity` is
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
    // First, so the settle's serialised repair reads the destination as the item's home rather
    // than the shelf it is leaving — otherwise the repair would dutifully undo the move.
    // `location_id` is no part of the quantity projection, so nothing else cares about the order.
    { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [toLocationId, itemId] },
    ...withRecomputeDeferred(consolidateStockStatements(itemId, toLocationId), itemId),
  ];
}

/**
 * Bracket a batch of statements so the derived-quantity recompute triggers stay dormant while they
 * run, then settle the projection once at the end (issue #548).
 *
 * There are two reasons a caller wants this, and they are not the same reason.
 *
 * A **restore or clone** rebuilds the stock ledger one row at a time, and the triggers see every
 * intermediate partial sum. An item with stock in two locations restores its settled `quantity`
 * first, then watches the projection knock it down to the first location's share and back up again
 * — and because that recompute writes `quantity` without touching `updated_at`, the auto-stamp
 * trigger fires on each step and re-stamps a row nobody edited. The damage is not cosmetic: the
 * bridge hydrates the served file through this path on every push, so those items always look newer
 * than the app's genuine edits to them, and last-write-wins discards the edits with a `200 ok`. The
 * app's Merge restore has the milder form of it — every multi-placement item comes back looking
 * freshly edited and beats a peer's newer version at the next sync.
 *
 * A **move** ({@link moveWholeItemStatements}) has a harder problem: for a SERIALISED instance the
 * intermediate sums are not merely noisy, they are *illegal*. See that function for why.
 *
 * Suppressing the triggers alone would not do, because the projection is not always a formality: a
 * Merge restore lands a backup's placements alongside local ones the backup never knew about, and
 * the totals genuinely have to be recomputed. So the settle pass runs inside the bracket, after the
 * caller's statements, doing set-based what the triggers did per row — and doing it once, from the
 * finished ledger, rather than from each partial sum along the way. On the ordinary consistent
 * snapshot it writes nothing and every `updated_at` restores byte-identical.
 *
 * `itemId` narrows the settle to one item; omit it to sweep everything, which is what a restore
 * needs and what a single move must not pay for.
 *
 * The switch is flipped inside the caller's own transaction, so a rollback restores it too. Only
 * wraps a non-empty batch, matching `withCaptureDisabled` — an empty transaction has no projection
 * to settle. **Do not nest one inside another**: the inner bracket restores the switch to 1 and
 * would re-arm the triggers for the remainder of the outer batch.
 */
export function withRecomputeDeferred(statements: readonly SqlStatement[], itemId?: string): SqlStatement[] {
  if (statements.length === 0) return [...statements];
  return [
    { sql: 'UPDATE stock_delta_capture SET recompute = 0 WHERE id = 1;' },
    ...statements,
    ...settleStockProjectionStatements(itemId),
    { sql: 'UPDATE stock_delta_capture SET recompute = 1 WHERE id = 1;' },
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
