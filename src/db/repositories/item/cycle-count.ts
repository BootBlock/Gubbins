/**
 * Cycle-counting & reconciliation concern (spec §4.4, Phases 9/26/28). Applies batches
 * of authorised adjustments atomically: the variance arithmetic is decided upstream in
 * the pure cycle-count module, and this concern trusts that decision (like `applyScrape`),
 * absorbing each variance at the right grain (whole-item / per-location / per-batch).
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { batchKeyOf, type BatchIdentity } from '@/features/inventory/batches';
import { placementDeltaStatements, runStockDraw, setBatchStatement, stockBatchRowId } from '../stock-batches';
import { markCountedStatement } from '../location-count';
import { stockRowId } from '../stock';
import type { Item, ReconciliationAdjustment, SerialisedReconciliation } from '../types';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** A planned batch of reconciliation writes plus the items they touch. */
interface CountPlan {
  readonly statements: SqlStatement[];
  readonly touched: string[];
}

/** What a whole authorised count actually wrote, split by tracking mode. */
export interface AuthorisedCount {
  /** DISCRETE items whose on-hand quantity was reconciled. */
  readonly discrete: Item[];
  /** SERIALISED instances retired by the presence audit. */
  readonly serialised: Item[];
}

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
      this.assertPermission('stock:write');
      this.assertWritable();
      const plan = await this.planReconcile(adjustments);
      if (plan.statements.length === 0) return [];
      await runStockDraw(this.driver, plan.statements);
      return this.loadTouched(plan.touched);
    }

    /**
     * The read-and-decide half of {@link reconcile}: validate each adjustment and build the
     * statements that absorb its variance, without executing anything. Split out so a whole
     * count authorisation — discrete reconciliation, serialised presence audit and the
     * location's "counted" stamp — can land in **one** transaction (issue #301).
     */
    private async planReconcile(adjustments: readonly ReconciliationAdjustment[]): Promise<CountPlan> {
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
          statements.push(
            historyStatement(adj.itemId, 'RECONCILED', this.actorId(), {
              quantityDelta: delta,
              note: adj.note,
            }),
          );
          touched.push(adj.itemId);
          continue;
        }

        if (adj.locationId) {
          // Per-location whole count: `counted` is this placement's new total. A surplus grows
          // the untracked default batch; a shortfall is drawn down FEFO across the lots present.
          const before = Number(
            (
              await this.driver.queryOne<{ quantity: number }>(
                'SELECT quantity FROM item_stock WHERE id = ?;',
                [stockRowId(adj.itemId, adj.locationId)],
              )
            )?.quantity ?? 0,
          );
          const delta = adj.counted - before;
          if (delta === 0) continue;
          statements.push(
            ...(await placementDeltaStatements(this.driver, adj.itemId, adj.locationId, delta)),
          );
          statements.push(
            historyStatement(adj.itemId, 'RECONCILED', this.actorId(), {
              quantityDelta: delta,
              note: adj.note,
            }),
          );
          touched.push(adj.itemId);
          continue;
        }

        const delta = adj.counted - existing.quantity;
        if (delta === 0) continue;
        // Whole-item: the variance is absorbed at the item's primary location (surplus → the
        // untracked default batch, shortfall → FEFO across that placement's lots, Phase 28).
        statements.push(
          ...(await placementDeltaStatements(this.driver, adj.itemId, existing.locationId, delta)),
        );
        statements.push(
          historyStatement(adj.itemId, 'RECONCILED', this.actorId(), {
            quantityDelta: delta,
            note: adj.note,
          }),
        );
        touched.push(adj.itemId);
      }

      return { statements, touched };
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
      this.assertPermission('stock:write');
      this.assertWritable();
      const plan = await this.planReconcileSerialised(adjustments);
      if (plan.statements.length === 0) return [];
      await runStockDraw(this.driver, plan.statements);
      return this.loadTouched(plan.touched);
    }

    /** The read-and-decide half of {@link reconcileSerialised} — see {@link planReconcile}. */
    private async planReconcileSerialised(
      adjustments: readonly SerialisedReconciliation[],
    ): Promise<CountPlan> {
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
        statements.push(
          historyStatement(adj.itemId, 'RECONCILED', this.actorId(), { quantityDelta: -1, note: adj.note }),
        );
        touched.push(adj.itemId);
      }

      return { statements, touched };
    }

    /**
     * Authorise a whole per-location count in **one transaction** (issue #301).
     *
     * A count is one user action but three writes — the discrete reconciliation, the serialised
     * presence audit, and stamping the location as counted. Running them as three awaited calls
     * meant a failure at the second left stock adjusted, presence unreconciled and the location
     * never stamped, with nothing to say which half applied. Planning all three up front and
     * committing them together makes the authorisation all-or-nothing.
     *
     * The location is stamped even when nothing drifted: a clean count is still a completed
     * audit, and that durable timestamp is what the audit-day picker and `LocationInfoCard`
     * read to show how long it has been since a location was verified.
     *
     * The one exception is a **system** location (Unassigned): the schema's
     * `trg_locations_protect_system_update` trigger aborts any UPDATE on one, so the stamp is
     * simply omitted rather than failing the count. Counting the loose stock in Unassigned is a
     * legitimate thing to do — before this was atomic it reconciled the stock and *then* raised
     * a constraint error on the stamp, which is the worst of both.
     */
    async authoriseCount(input: {
      readonly locationId: string;
      readonly quantityAdjustments: readonly ReconciliationAdjustment[];
      readonly serialisedAdjustments: readonly SerialisedReconciliation[];
      readonly countedAt?: number;
    }): Promise<AuthorisedCount> {
      this.assertPermission('stock:write');
      this.assertWritable();
      const discrete = await this.planReconcile(input.quantityAdjustments);
      const serialised = await this.planReconcileSerialised(input.serialisedAdjustments);
      const isSystem = Boolean(
        (
          await this.driver.queryOne<{ is_system: number }>('SELECT is_system FROM locations WHERE id = ?;', [
            input.locationId,
          ])
        )?.is_system,
      );
      await runStockDraw(this.driver, [
        ...discrete.statements,
        ...serialised.statements,
        ...(isSystem ? [] : [markCountedStatement(input.locationId, input.countedAt ?? Date.now())]),
      ]);
      return {
        discrete: await this.loadTouched(discrete.touched),
        serialised: await this.loadTouched(serialised.touched),
      };
    }

    /** Re-read the items a plan wrote, dropping any that vanished under a concurrent delete. */
    private async loadTouched(ids: readonly string[]): Promise<Item[]> {
      const updated = await Promise.all(ids.map((id) => this.getById(id)));
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
