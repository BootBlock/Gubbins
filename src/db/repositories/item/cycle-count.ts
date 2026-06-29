/**
 * Cycle-counting & reconciliation concern (spec §4.4, Phases 9/26/28). Applies batches
 * of authorised adjustments atomically: the variance arithmetic is decided upstream in
 * the pure cycle-count module, and this concern trusts that decision (like `applyScrape`),
 * absorbing each variance at the right grain (whole-item / per-location / per-batch).
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { batchKeyOf, type BatchIdentity } from '@/features/inventory/batches';
import {
  placementDeltaStatements,
  setBatchStatement,
  stockBatchRowId,
} from '../stock-batches';
import { stockRowId } from '../stock';
import type { Item, ReconciliationAdjustment, SerialisedReconciliation } from '../types';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withCycleCount<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemCycleCountRepository extends Base {
    /**
     * Apply a batch of authorised Reconciliation Adjustments (spec §4.4) atomically.
     * Each adjustment sets a DISCRETE item's on-hand quantity to the physically
     * counted value and records a `RECONCILED` ledger entry whose `quantity_delta` is
     * the variance (counted − previous) and whose note was composed upstream from the
     * blind count. The variance arithmetic itself lives in the pure cycle-count
     * module; this method trusts the decision, like `applyScrape`. Write-gated.
     * A zero-variance adjustment is skipped (no-op, not logged).
     *
     * Per-location (Phase 26): when an adjustment carries a `locationId`, the variance is
     * computed against — and absorbed at — *that* placement's `item_stock` row, and
     * `counted` becomes that location's new quantity (so an item split across drawers can
     * be audited one drawer at a time). With no `locationId`, the legacy whole-item path
     * applies: `counted` is the new on-hand total, absorbed at the item's primary location.
     *
     * Per-batch (Phase 28): when an adjustment also carries a `batch`, `counted` becomes
     * *that lot's* new quantity at the placement (the variance absorbed at its `stock_batches`
     * row), so a drawer's lots can be audited one at a time. A whole-placement / whole-item
     * count instead absorbs a surplus into the untracked default batch and draws a shortfall
     * down FEFO across the placement's lots.
     */
    async reconcile(adjustments: readonly ReconciliationAdjustment[]): Promise<Item[]> {
      this.assertWritable();
      const statements: SqlStatement[] = [];
      const touched: string[] = [];

      for (const adj of adjustments) {
        if (!Number.isInteger(adj.counted) || adj.counted < 0) {
          throw new DbError('SQLITE_CONSTRAINT', 'A counted quantity must be a non-negative whole number.');
        }
        const existing = await this.require(adj.itemId);
        if (existing.trackingMode !== 'DISCRETE') {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `Cycle counting reconciles DISCRETE items only (${existing.name} is ${existing.trackingMode}).`,
          );
        }

        if (adj.locationId && adj.batch) {
          // Per-batch: `counted` is this lot's new absolute quantity at the placement. The
          // batch row is upserted (a surplus of a previously-unseen lot seeds it); the
          // recompute triggers re-derive item_stock then items.quantity (Phase 28).
          const before = await this.batchQuantity(adj.itemId, adj.locationId, adj.batch);
          const delta = adj.counted - before;
          if (delta === 0) continue;
          statements.push(setBatchStatement(adj.itemId, adj.locationId, adj.batch, adj.counted));
          statements.push(historyStatement(adj.itemId, 'RECONCILED', { quantityDelta: delta, note: adj.note }));
          touched.push(adj.itemId);
          continue;
        }

        if (adj.locationId) {
          // Per-location whole count: `counted` is this placement's new total. A surplus grows
          // the untracked default batch; a shortfall is drawn down FEFO across the lots present.
          const before = Number(
            (
              await this.driver.queryOne<{ quantity: number }>('SELECT quantity FROM item_stock WHERE id = ?;', [
                stockRowId(adj.itemId, adj.locationId),
              ])
            )?.quantity ?? 0,
          );
          const delta = adj.counted - before;
          if (delta === 0) continue;
          statements.push(...(await placementDeltaStatements(this.driver, adj.itemId, adj.locationId, delta)));
          statements.push(historyStatement(adj.itemId, 'RECONCILED', { quantityDelta: delta, note: adj.note }));
          touched.push(adj.itemId);
          continue;
        }

        const delta = adj.counted - existing.quantity;
        if (delta === 0) continue;
        // Whole-item: the variance is absorbed at the item's primary location (surplus → the
        // untracked default batch, shortfall → FEFO across that placement's lots, Phase 28).
        statements.push(...(await placementDeltaStatements(this.driver, adj.itemId, existing.locationId, delta)));
        statements.push(historyStatement(adj.itemId, 'RECONCILED', { quantityDelta: delta, note: adj.note }));
        touched.push(adj.itemId);
      }

      if (statements.length === 0) return [];
      await this.driver.transaction(statements);
      const updated = await Promise.all(touched.map((id) => this.getById(id)));
      return updated.filter((i): i is Item => i !== undefined);
    }

    /**
     * Authorise a serialised cycle-count audit (spec §4.4). A SERIALISED instance is
     * a qty-1 record, so an audit reconciles **presence**: each named instance the
     * auditor could not find is soft-deleted (`is_active = 0`, reversible via
     * `restore`) and logged as `RECONCILED` with a `quantity_delta` of −1 (the
     * unit that left active inventory). The present/missing decision is made upstream
     * — this method trusts the passed missing set, mirroring {@link reconcile}.
     * Rejects a non-SERIALISED item; skips an already-inactive instance (no-op).
     * Write-gated.
     */
    async reconcileSerialised(adjustments: readonly SerialisedReconciliation[]): Promise<Item[]> {
      this.assertWritable();
      const statements: SqlStatement[] = [];
      const touched: string[] = [];

      for (const adj of adjustments) {
        const existing = await this.require(adj.itemId);
        if (existing.trackingMode !== 'SERIALISED') {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `Serialised audit reconciles SERIALISED instances only (${existing.name} is ${existing.trackingMode}).`,
          );
        }
        if (!existing.isActive) continue; // already removed from active inventory → no-op
        statements.push({ sql: 'UPDATE items SET is_active = 0 WHERE id = ?;', params: [adj.itemId] });
        statements.push(historyStatement(adj.itemId, 'RECONCILED', { quantityDelta: -1, note: adj.note }));
        touched.push(adj.itemId);
      }

      if (statements.length === 0) return [];
      await this.driver.transaction(statements);
      const updated = await Promise.all(touched.map((id) => this.getById(id)));
      return updated.filter((i): i is Item => i !== undefined);
    }

    /** Current quantity of a specific batch at a placement (0 if the lot has no row yet). */
    private async batchQuantity(
      itemId: string,
      locationId: string,
      identity: BatchIdentity,
    ): Promise<number> {
      const row = await this.driver.queryOne<{ quantity: number }>(
        'SELECT quantity FROM stock_batches WHERE id = ?;',
        [stockBatchRowId(itemId, locationId, batchKeyOf(identity))],
      );
      return Number(row?.quantity ?? 0);
    }
  };
}
