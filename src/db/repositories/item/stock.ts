/**
 * Per-location stock & batch concern (spec §4 per-location ledger, Phases 25–29).
 *
 * Reads the `item_stock` and `stock_batches` ledgers for the per-location and
 * per-batch breakdowns, and the partial-move/quantity mutations that shift stock
 * between placements. `items.quantity` is a derived projection of these ledgers,
 * maintained by the recompute triggers — these methods never write it directly.
 */
import { DbError } from '../../errors';
import { planTransfer } from '@/features/inventory/stock';
import {
  isDefaultBatch,
  planBatchConsumption,
  planBatchSelection,
} from '@/features/inventory/batches';
import {
  addBatchStatement,
  consumeBatchStatements,
  placementDeltaStatements,
  readPlacementBatches,
} from '../stock-batches';
import type { Item, ItemStockPlacement } from '../types';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** One DISCRETE placement at a location for the §4.4 per-location cycle count (Phase 26). */
export interface LocationStockLine {
  readonly itemId: string;
  readonly name: string;
  /** This location's on-hand quantity for the item — the expected blind-count value. */
  readonly quantity: number;
}

/** One batch of an item's stock at a location, for the §4 batch breakdown (Phase 28). */
export interface ItemBatchPlacement {
  readonly locationId: string;
  readonly locationName: string;
  readonly batchKey: string;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly expiryDate: number | null;
  readonly quantity: number;
}

/** One DISCRETE batch at a location for the §4.4 batch-aware cycle count (Phase 28). */
export interface LocationBatchLine {
  readonly itemId: string;
  readonly name: string;
  readonly batchKey: string;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly expiryDate: number | null;
  /** This lot's on-hand quantity at the location — the expected blind-count value. */
  readonly quantity: number;
}

export function withStock<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemStockRepository extends Base {
    /**
     * The per-location stock breakdown for an item (spec §4 per-location ledger, Phase
     * 25), busiest location first. Only placements actually holding stock are returned;
     * `items.quantity` is the sum of these. A single-location item yields one row.
     */
    async listStock(itemId: string): Promise<ItemStockPlacement[]> {
      const rows = await this.driver.query<{
        location_id: string;
        location_name: string;
        quantity: number;
      }>(
        `SELECT s.location_id, l.name AS location_name, s.quantity
         FROM item_stock s JOIN locations l ON l.id = s.location_id
         WHERE s.item_id = ? AND s.quantity > 0
         ORDER BY s.quantity DESC, l.name COLLATE NOCASE ASC;`,
        [itemId],
      );
      return rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        quantity: Number(r.quantity),
      }));
    }

    /**
     * The DISCRETE placements physically sitting *at* a location (spec §4.4 per-location
     * cycle count, Phase 26), busiest first. Unlike `list({ locationId })` — which filters
     * on the item's *primary* `location_id` and reports the item's grand total — this reads
     * the `item_stock` ledger, so it correctly includes an item whose primary location is
     * elsewhere but which holds a secondary placement here, and reports *this location's*
     * quantity as the expected count. SERIALISED instances (audited by presence) and gauges
     * are excluded — only DISCRETE quantities are blind-counted.
     */
    async listStockAtLocation(locationId: string): Promise<LocationStockLine[]> {
      const rows = await this.driver.query<{
        item_id: string;
        item_name: string;
        quantity: number;
      }>(
        `SELECT s.item_id, i.name AS item_name, s.quantity
         FROM item_stock s JOIN items i ON i.id = s.item_id
         WHERE s.location_id = ? AND s.quantity > 0
           AND i.tracking_mode = 'DISCRETE' AND i.is_active = 1
         ORDER BY s.quantity DESC, i.name COLLATE NOCASE ASC;`,
        [locationId],
      );
      return rows.map((r) => ({
        itemId: r.item_id,
        name: r.item_name,
        quantity: Number(r.quantity),
      }));
    }

    /**
     * The batch-level breakdown of an item's stock (spec §4 perishables, Phase 28): one row
     * per `(location, batch)` actually holding units, FEFO-ordered within each location
     * (soonest expiry first, the untracked remainder last). Feeds the per-location batch
     * sub-breakdown on the item detail. A non-perishable item yields one untracked row per
     * placement (the default batch), so the UI can collapse it to the Phase-25 view.
     */
    async listItemBatches(itemId: string): Promise<ItemBatchPlacement[]> {
      const rows = await this.driver.query<{
        location_id: string;
        location_name: string;
        batch_key: string;
        batch_number: string | null;
        lot_number: string | null;
        expiry_date: number | null;
        quantity: number;
      }>(
        `SELECT s.location_id, l.name AS location_name, s.batch_key, s.batch_number,
                s.lot_number, s.expiry_date, s.quantity
         FROM stock_batches s JOIN locations l ON l.id = s.location_id
         WHERE s.item_id = ? AND s.quantity > 0
         ORDER BY l.name COLLATE NOCASE ASC,
                  CASE WHEN s.expiry_date IS NULL THEN 1 ELSE 0 END ASC, s.expiry_date ASC, s.batch_key ASC;`,
        [itemId],
      );
      return rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        batchKey: r.batch_key,
        batchNumber: r.batch_number,
        lotNumber: r.lot_number,
        expiryDate: r.expiry_date,
        quantity: Number(r.quantity),
      }));
    }

    /**
     * The DISCRETE batches physically sitting *at* a location (spec §4.4 batch-aware cycle
     * count, Phase 28), FEFO-ordered. Like {@link listStockAtLocation} but resolved to the
     * `stock_batches` grain, so the auditor counts each lot in the drawer one at a time.
     */
    async listStockBatchesAtLocation(locationId: string): Promise<LocationBatchLine[]> {
      const rows = await this.driver.query<{
        item_id: string;
        item_name: string;
        batch_key: string;
        batch_number: string | null;
        lot_number: string | null;
        expiry_date: number | null;
        quantity: number;
      }>(
        `SELECT s.item_id, i.name AS item_name, s.batch_key, s.batch_number, s.lot_number,
                s.expiry_date, s.quantity
         FROM stock_batches s JOIN items i ON i.id = s.item_id
         WHERE s.location_id = ? AND s.quantity > 0
           AND i.tracking_mode = 'DISCRETE' AND i.is_active = 1
         ORDER BY i.name COLLATE NOCASE ASC,
                  CASE WHEN s.expiry_date IS NULL THEN 1 ELSE 0 END ASC, s.expiry_date ASC, s.batch_key ASC;`,
        [locationId],
      );
      return rows.map((r) => ({
        itemId: r.item_id,
        name: r.item_name,
        batchKey: r.batch_key,
        batchNumber: r.batch_number,
        lotNumber: r.lot_number,
        expiryDate: r.expiry_date,
        quantity: Number(r.quantity),
      }));
    }

    /**
     * Transfer part (or all) of a DISCRETE item's stock from one location to another
     * (spec §4 per-location ledger, Phase 25). The amount is clamped to what the source
     * holds by the pure {@link planTransfer}; the item's grand total is unchanged (the
     * units merely move), so `items.quantity` (the derived projection) is untouched while
     * the two placements shift. Logged as a `MOVED` ledger entry. Write-gated.
     */
    async transferStock(
      itemId: string,
      fromLocationId: string,
      toLocationId: string,
      quantity: number,
      batchKey?: string,
    ): Promise<Item> {
      this.assertWritable();
      const existing = await this.require(itemId);
      if (existing.trackingMode !== 'DISCRETE') {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Only DISCRETE items can be split across locations (this is ${existing.trackingMode}).`,
        );
      }
      if (fromLocationId === toLocationId) {
        throw new DbError('SQLITE_CONSTRAINT', 'Choose a different destination location.');
      }
      const locs = await this.driver.query<{ id: string; name: string }>(
        'SELECT id, name FROM locations WHERE id IN (?, ?);',
        [fromLocationId, toLocationId],
      );
      const names = new Map(locs.map((l) => [l.id, l.name]));
      if (!names.has(toLocationId)) {
        throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Location "${toLocationId}" does not exist.`);
      }

      // Read the source placement's batch composition so the move preserves each lot's identity
      // at the destination (Phase 28). When the caller picks a *specific* lot (Phase 29), only
      // that lot moves and the amount is clamped to its own quantity; otherwise the move draws
      // FEFO across the placement (the soonest-expiring lots first).
      const srcBatches = await readPlacementBatches(this.driver, itemId, fromLocationId);
      const selectedKey = batchKey !== undefined && !isDefaultBatch(batchKey) ? batchKey : undefined;
      const available = selectedKey
        ? (srcBatches.find((b) => b.batchKey === selectedKey)?.quantity ?? 0)
        : srcBatches.reduce((sum, b) => sum + b.quantity, 0);
      const plan = planTransfer(available, quantity);
      if (!plan.ok) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          selectedKey
            ? `Not enough of the chosen lot to transfer: ${available} available.`
            : `Not enough stock at the source location to transfer: ${available} available.`,
        );
      }

      // Each moved slice is recreated at the destination under its own identity, so a tracked
      // lot keeps its batch/expiry across drawers.
      const consumption = selectedKey
        ? planBatchSelection(srcBatches, selectedKey, plan.quantity)
        : planBatchConsumption(srcBatches, plan.quantity);
      const byKey = new Map(srcBatches.map((b) => [b.batchKey, b]));
      const fromName = names.get(fromLocationId) ?? 'another location';
      const toName = names.get(toLocationId) ?? 'another location';
      await this.driver.transaction([
        ...consumeBatchStatements(itemId, fromLocationId, consumption),
        ...consumption.consumed.map((c) => {
          const b = byKey.get(c.batchKey)!;
          return addBatchStatement(
            itemId,
            toLocationId,
            { batchNumber: b.batchNumber, lotNumber: b.lotNumber, expiryDate: b.expiryDate },
            c.amount,
          );
        }),
        historyStatement(itemId, 'MOVED', {
          note: `Transferred ${plan.quantity} from "${fromName}" to "${toName}".`,
          metadata: { fromLocationId, toLocationId, quantity: plan.quantity, batchKey: selectedKey ?? null },
        }),
      ]);
      return (await this.getById(itemId))!;
    }

    /**
     * Adjust the quantity of a DISCRETE item by a signed delta, logging the change.
     * SERIALISED items are fixed at 1; gauge items use `adjustGauge`.
     */
    async adjustQuantity(id: string, delta: number, note?: string): Promise<Item> {
      this.assertWritable();
      const existing = await this.require(id);
      if (existing.trackingMode !== 'DISCRETE') {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Quantity adjustment applies only to DISCRETE items (this is ${existing.trackingMode}).`,
        );
      }
      if (!Number.isInteger(delta)) {
        throw new DbError('SQLITE_CONSTRAINT', 'Quantity delta must be a whole number.');
      }
      const next = existing.quantity + delta;
      if (next < 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'Quantity cannot fall below zero.');
      }

      // The adjustment lands on the item's primary (home) location in the per-location
      // ledger; a positive delta grows the untracked default batch, a negative one is drawn
      // down first-expiry-first-out (Phase 28); `items.quantity` follows via the recompute
      // triggers. Splitting stock across locations is done with `transferStock`.
      const stockStatements = await placementDeltaStatements(this.driver, id, existing.locationId, delta);
      await this.driver.transaction([
        ...stockStatements,
        historyStatement(id, 'QUANTITY_CHANGE', {
          quantityDelta: delta,
          note: note ?? `Quantity ${delta >= 0 ? '+' : ''}${delta} (now ${next}).`,
        }),
      ]);
      return (await this.getById(id))!;
    }
  };
}
