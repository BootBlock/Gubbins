/**
 * Cycle-counting & reconciliation concern (spec §4.4, Phases 9/26/28). Applies batches
 * of authorised adjustments atomically: the upstream cycle-count session decides what was
 * counted where and this concern trusts that (like `applyScrape`), measuring each count
 * against the live ledger and absorbing the variance at the right grain (whole-item /
 * per-location / per-batch).
 */
import { DbError } from '../../errors';
import type { SqlStatement, SqlValue } from '../../rpc/driver';
import { batchKeyOf } from '@/features/inventory/batches';
import { reconciliationNote } from '@/features/lifecycle/cycle-count';
import {
  placementDeltaStatements,
  runStockDraw,
  setBatchStatement,
  stockBatchRowId,
  withAssertedCount,
} from '../stock-batches';
import { markCountedStatement } from '../location-count';
import { moveWholeItemStatements, stockRowId } from '../stock';
import type { TrackingMode } from '../constants';
import type {
  Item,
  ReconciliationAdjustment,
  SerialisedRelocation,
  SerialisedReconciliation,
} from '../types';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/**
 * How many bound parameters one `IN (…)` read may carry (issue #561). SQLite's own default
 * ceiling is far higher, but a count authorised at a bulk-storage location can carry thousands
 * of adjustments, and a single statement bound to all of them would be one host limit away from
 * failing the whole audit. Chunking keeps the read a fixed number of round-trips per thousand
 * lines instead of one per line, without betting on a driver's variable limit.
 */
const IN_CHUNK = 400;

/** Split a list of ids into `IN (…)`-sized chunks. */
function chunked<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) chunks.push(values.slice(i, i + IN_CHUNK));
  return chunks;
}

/**
 * The item facts a reconciliation plan needs about one adjusted item — everything the old
 * per-adjustment `require()` was read for, and nothing else (issue #561).
 *
 * `require()` returns a full `Item`, so planning a count of N lines meant N `getById` reads,
 * each projecting `ITEM_READ_COLUMNS` and so each dragging that item's thumbnail BLOB through
 * the worker boundary, all of it discarded but these five fields. They are read for the whole
 * batch in one round-trip per chunk instead.
 */
interface CountTarget {
  readonly name: string;
  readonly trackingMode: TrackingMode;
  readonly quantity: number;
  readonly locationId: string;
  readonly isActive: boolean;
}

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
  /** SERIALISED instances moved into the counted location because they were found there (#640). */
  readonly relocated: Item[];
}

/**
 * The pre-read facts for one adjusted item, or the same constraint error `require()` raised
 * when the item is gone. Kept identical in wording so a reconciliation naming a deleted item
 * still fails exactly as it always did.
 */
function requireTarget(targets: ReadonlyMap<string, CountTarget>, itemId: string): CountTarget {
  const target = targets.get(itemId);
  if (!target) {
    throw new DbError('SQLITE_CONSTRAINT', `Item "${itemId}" does not exist.`);
  }
  return target;
}

export function withCycleCount<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemCycleCountRepository extends Base {
    /**
     * Apply a batch of authorised Reconciliation Adjustments (spec §4.4) atomically.
     * Each adjustment sets a DISCRETE item's on-hand quantity to the physically
     * counted value and records a `RECONCILED` ledger entry whose `quantity_delta` is
     * the variance (counted − previous) and whose note states that same variance in
     * words, both read here so they cannot disagree (see {@link reconciledEntry}). What
     * was counted where is the upstream session's decision; this method trusts it, like
     * `applyScrape`. Write-gated. A zero-variance adjustment is skipped (no-op, not logged).
     *
     * A count that names its lot is captured as an **absolute assertion** rather than a relative
     * movement (issue #633) — see {@link withAssertedCount} for why a count reaching the
     * convergence ledger as the correction it implies is applied twice across two devices. A
     * whole-placement or whole-item count is not; the per-location branch below says why.
     *
     * A **zero-variance** count still writes nothing at all, so it leaves no assertion to
     * supersede an earlier, disagreeing count from another device. That is deliberate: recording
     * one would mean a ledger row per counted lot per count, in an append-only table that travels
     * whole in every sync snapshot, so a routine audit day would grow it by the size of the
     * inventory. A count with nothing to correct changes no number here, and does not claim to.
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

      // The item behind each adjustment, and the quantity its variance is measured against,
      // read for the whole batch first (issue #561). Planning used to await both *per line* — a
      // full `getById` plus the lot's or the placement's current quantity — so authorising a
      // bulk-storage location's count stalled for thousands of sequential worker calls with
      // nothing on screen to say why. Neither read writes, and neither depends on the other's
      // result, so hoisting them changes only how many times the worker is asked. The loop
      // keeps its original order and its original failure points: a bad count, a missing item
      // and a wrong tracking mode are still raised at the same adjustment, in the same order,
      // because only the *source* of each fact moved.
      //
      // The loop is not read-free after this: a *shortfall* on the whole-placement or
      // whole-item branch still awaits `placementDeltaStatements`, which reads the placement's
      // lots to draw them down FEFO. That allocation depends on the delta this adjustment
      // computes, so it cannot be hoisted with the rest — and the count sheet never reaches
      // those branches anyway (it always names the lot).
      const targets = await this.loadCountTargets(adjustments.map((a) => a.itemId));
      const quantities = await this.loadCountedQuantities(adjustments);

      for (const adj of adjustments) {
        if (!Number.isInteger(adj.counted) || adj.counted < 0) {
          throw new DbError('SQLITE_CONSTRAINT', 'A counted quantity must be a non-negative whole number.');
        }
        const existing = requireTarget(targets, adj.itemId);
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
          const before =
            quantities.get(stockBatchRowId(adj.itemId, adj.locationId, batchKeyOf(adj.batch))) ?? 0;
          const delta = adj.counted - before;
          if (delta === 0) continue;
          // The only write in this concern that states a *physically observed* quantity for one
          // ledger row, so the only one captured as an assertion (issue #633) — see
          // {@link withAssertedCount}, and the note on the other two branches below.
          statements.push(
            ...withAssertedCount([setBatchStatement(adj.itemId, adj.locationId, adj.batch, adj.counted)]),
          );
          statements.push(this.reconciledEntry(adj, existing.name, before, delta));
          touched.push(adj.itemId);
          continue;
        }

        if (adj.locationId) {
          // Per-location whole count: `counted` is this placement's new total. A surplus grows
          // the untracked default batch; a shortfall is drawn down FEFO across the lots present.
          //
          // Deliberately **not** captured as an assertion (issue #633). `counted` is a statement
          // about the placement, while the ledger's assertions are per `stock_batches` row, and
          // what lands on each row here is a FEFO allocation rather than anything anyone saw. Two
          // devices counting a multi-lot placement would allocate differently, and "newest
          // assertion wins" applied per row would then converge on the sum of two different
          // allocations — a total neither counter reported. A relative movement composes correctly
          // in that case, so this path keeps the pre-#633 behaviour, double-application and all.
          // The count sheet always names the lot (`useLocationCycleCount` passes `batch`), so the
          // path a user reaches is the asserted one above.
          const before = quantities.get(stockRowId(adj.itemId, adj.locationId)) ?? 0;
          const delta = adj.counted - before;
          if (delta === 0) continue;
          statements.push(
            ...(await placementDeltaStatements(this.driver, adj.itemId, adj.locationId, delta)),
          );
          statements.push(this.reconciledEntry(adj, existing.name, before, delta));
          touched.push(adj.itemId);
          continue;
        }

        const delta = adj.counted - existing.quantity;
        if (delta === 0) continue;
        // Whole-item: the variance is absorbed at the item's primary location (surplus → the
        // untracked default batch, shortfall → FEFO across that placement's lots, Phase 28).
        // Not captured as an assertion, for the reason given on the per-location branch above.
        statements.push(
          ...(await placementDeltaStatements(this.driver, adj.itemId, existing.locationId, delta)),
        );
        statements.push(this.reconciledEntry(adj, existing.name, existing.quantity, delta));
        touched.push(adj.itemId);
      }

      return { statements, touched };
    }

    /**
     * The `RECONCILED` ledger entry for one applied adjustment, composed from the **live** figures
     * this plan just read (issue #633).
     *
     * The note and the entry's `quantity_delta` are two statements of the same variance, and the
     * Activity Log shows them side by side — the note as the detail line, the delta as the badge.
     * Composing the note upstream from the count sheet's load-time quantity let them disagree
     * whenever stock moved while the sheet was open: "expected 10 (adjustment -2)" beside a badge
     * reading −5. Both now derive from `before`, so the row can only ever agree with itself.
     */
    private reconciledEntry(
      adj: ReconciliationAdjustment,
      name: string,
      before: number,
      delta: number,
    ): SqlStatement {
      return historyStatement(adj.itemId, 'RECONCILED', this.actorId(), {
        quantityDelta: delta,
        note: reconciliationNote(
          { itemId: adj.itemId, name, expected: before, counted: adj.counted, variance: delta },
          adj.locationName,
        ),
      });
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

      // One read for the whole presence audit rather than a `getById` per missing instance —
      // see the note in {@link planReconcile} (issue #561).
      const targets = await this.loadCountTargets(adjustments.map((a) => a.itemId));

      for (const adj of adjustments) {
        const existing = requireTarget(targets, adj.itemId);
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
     * The read-and-decide half of a **found here** relocation (issue #640) — see
     * {@link planReconcile}.
     *
     * A presence audit that can only record an absence turns every misplacement into a loss: the
     * shelf that should hold a unit reports it missing and retires it, while the shelf that
     * actually holds it has no line to say so. This is the other half. Each named instance is
     * repointed at the location being counted through {@link moveWholeItemStatements} — the same
     * builder {@link ItemCoreRepository.move} uses, so there is one definition of a wholesale move
     * rather than two — and logged as `MOVED`, because nothing has left inventory and no quantity
     * changed.
     *
     * Planned rather than executed so it commits with the rest of the count (issue #301): a count
     * must not be able to record the absence at one shelf and then fail to record the presence at
     * the other, which is the very failure this exists to prevent.
     *
     * Rejects a non-SERIALISED item, and skips an instance that is inactive or already at the
     * location (a no-op, so a count authorised twice — or replayed on a second device after a
     * sync — moves nothing the second time).
     */
    private async planFoundHere(
      locationId: string,
      relocations: readonly SerialisedRelocation[],
    ): Promise<CountPlan> {
      const statements: SqlStatement[] = [];
      const touched: string[] = [];
      if (relocations.length === 0) return { statements, touched };

      // A relocation writes `items.location_id`, which every other item move gates on
      // `items:write` rather than the `stock:write` the rest of a count needs. Asserted here, so
      // a count that relocates nothing is not held to a permission it never exercises.
      this.assertPermission('items:write');

      const targets = await this.loadCountTargets(relocations.map((r) => r.itemId));

      for (const adj of relocations) {
        const existing = requireTarget(targets, adj.itemId);
        if (existing.trackingMode !== 'SERIALISED') {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `Serialised audit reconciles SERIALISED instances only (${existing.name} is ${existing.trackingMode}).`,
          );
        }
        if (!existing.isActive) continue; // not in active inventory → nothing to relocate
        if (existing.locationId === locationId) continue; // already recorded here → no-op
        statements.push(
          ...moveWholeItemStatements(adj.itemId, locationId),
          historyStatement(adj.itemId, 'MOVED', this.actorId(), {
            note: adj.note,
            metadata: { fromLocationId: existing.locationId, toLocationId: locationId },
          }),
        );
        touched.push(adj.itemId);
      }

      return { statements, touched };
    }

    /**
     * Authorise a whole per-location count in **one transaction** (issue #301).
     *
     * A count is one user action but several writes — the discrete reconciliation, the serialised
     * presence audit, any **found here** relocations (issue #640), and stamping the location as
     * counted. Running them as separate awaited calls meant a failure at the second left stock
     * adjusted, presence unreconciled and the location never stamped, with nothing to say which
     * half applied. Planning them all up front and committing them together makes the
     * authorisation all-or-nothing — which matters most for the relocations, since the shelf a
     * unit was found on and the shelf it was recorded on are corrected by different halves of the
     * same count.
     *
     * The location is stamped even when nothing drifted: a clean count is still a completed
     * audit, and that durable timestamp is what the audit-day picker and `LocationInfoCard`
     * read to show how long it has been since a location was verified.
     *
     * A count that did *not* cover every line is the exception (issue #637). Passing
     * `markCounted: false` applies the adjustments for the lines that were counted but omits
     * the stamp, so a shelf where half the lines were left blank does not read as verified.
     * A false last-counted date is worse than none: it is what tells the auditor which shelves
     * are stale, so a partial count must not clear the location off that list.
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
      /** SERIALISED instances found in this location that the records place elsewhere (#640). */
      readonly relocations?: readonly SerialisedRelocation[];
      readonly countedAt?: number;
      /**
       * Stamp the location as counted (default `true`). Pass `false` for a count that did
       * not cover the whole sheet — see the note above.
       */
      readonly markCounted?: boolean;
    }): Promise<AuthorisedCount> {
      this.assertPermission('stock:write');
      this.assertWritable();
      const discrete = await this.planReconcile(input.quantityAdjustments);
      const serialised = await this.planReconcileSerialised(input.serialisedAdjustments);
      const relocated = await this.planFoundHere(input.locationId, input.relocations ?? []);
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
        ...relocated.statements,
        ...(isSystem || input.markCounted === false
          ? []
          : [markCountedStatement(input.locationId, input.countedAt ?? Date.now())]),
      ]);
      return {
        discrete: await this.loadTouched(discrete.touched),
        serialised: await this.loadTouched(serialised.touched),
        relocated: await this.loadTouched(relocated.touched),
      };
    }

    /**
     * Re-read the items a plan wrote, dropping any that vanished under a concurrent delete.
     *
     * In bulk, through {@link ItemCoreRepository.getManyById} (issue #561): a `getById` per
     * touched item left the very cost this concern's planning was rewritten to remove sitting
     * on the *result* path, where a count of a bulk location would pay it a few thousand times
     * over. The list keeps one entry per id it was given, duplicates included — a count that
     * drifted two lots of the same item wrote two adjustments, and the caller reports that
     * total.
     */
    private async loadTouched(ids: readonly string[]): Promise<Item[]> {
      const byId = new Map<string, Item>();
      for (const chunk of chunked([...new Set(ids)])) {
        for (const [id, item] of await this.getManyById(chunk)) byId.set(id, item);
      }
      return ids.map((id) => byId.get(id)).filter((i): i is Item => i !== undefined);
    }

    /**
     * The {@link CountTarget} for each adjusted item, keyed by id, in one round-trip per chunk
     * (issue #561). Missing ids are simply absent — {@link requireTarget} raises the same
     * "does not exist" constraint error `require()` did, at the same adjustment.
     */
    private async loadCountTargets(ids: readonly string[]): Promise<Map<string, CountTarget>> {
      const unique = [...new Set(ids)];
      const byId = new Map<string, CountTarget>();
      for (const chunk of chunked(unique)) {
        const rows = await this.driver.query<{
          id: string;
          name: string;
          tracking_mode: TrackingMode;
          quantity: number;
          location_id: string;
          is_active: number;
        }>(
          `SELECT id, name, tracking_mode, quantity, location_id, is_active FROM items
           WHERE id IN (${chunk.map(() => '?').join(', ')});`,
          chunk as SqlValue[],
        );
        for (const row of rows) {
          byId.set(row.id, {
            name: row.name,
            trackingMode: row.tracking_mode,
            quantity: Number(row.quantity),
            locationId: row.location_id,
            isActive: Boolean(row.is_active),
          });
        }
      }
      return byId;
    }

    /**
     * The current quantity behind every adjustment that measures its variance against a stored
     * row — the lot's `stock_batches` row for a per-batch count, the placement's `item_stock`
     * row for a per-placement one — keyed by that row's id (issue #561).
     *
     * A row that does not exist yet is absent from the map, and both callers default it to 0,
     * exactly as the single-row reads they replace did. A whole-item count is not represented
     * here: it measures against `items.quantity`, which the item read above already carries.
     */
    private async loadCountedQuantities(
      adjustments: readonly ReconciliationAdjustment[],
    ): Promise<Map<string, number>> {
      const batchIds = new Set<string>();
      const placementIds = new Set<string>();
      for (const adj of adjustments) {
        if (!adj.locationId) continue;
        if (adj.batch) batchIds.add(stockBatchRowId(adj.itemId, adj.locationId, batchKeyOf(adj.batch)));
        else placementIds.add(stockRowId(adj.itemId, adj.locationId));
      }
      // Two literal statements rather than one over an interpolated table name: the row-shape
      // guard can only prepare a statement whose text is fixed, and a read it cannot prepare is
      // a read nothing checks the projection of (`query-row-shape.test.ts`). The two id spaces
      // are disjoint, so one map holds both.
      const quantities = new Map<string, number>();
      for (const chunk of chunked([...batchIds])) {
        const rows = await this.driver.query<{ id: string; quantity: number }>(
          `SELECT id, quantity FROM stock_batches WHERE id IN (${chunk.map(() => '?').join(', ')});`,
          chunk as SqlValue[],
        );
        for (const row of rows) quantities.set(row.id, Number(row.quantity));
      }
      for (const chunk of chunked([...placementIds])) {
        const rows = await this.driver.query<{ id: string; quantity: number }>(
          `SELECT id, quantity FROM item_stock WHERE id IN (${chunk.map(() => '?').join(', ')});`,
          chunk as SqlValue[],
        );
        for (const row of rows) quantities.set(row.id, Number(row.quantity));
      }
      return quantities;
    }
  };
}
