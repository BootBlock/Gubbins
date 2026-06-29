/**
 * ItemRepository (spec §2.1.1, §4, §4.1).
 *
 * Encapsulates all SQL for items, including the inline Consumable-Gauge primitive.
 * Every mutation records an entry in the immutable Activity Log (`item_history`)
 * within the same atomic transaction, so the ledger can never drift from the item
 * state. Reads are strictly paginated (§2.1). Storage-growing writes are gated by
 * the Hard Stop; deletions are always permitted (they free space).
 */
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { buildFtsMatch } from '../search/fts';
import { collectCapabilityKeys, parseASTtoSQL } from '../search/parseASTtoSQL';
import type { SearchAST } from '../search/ast';
import { validateVariantLink, variantRejectionMessage } from '@/features/lifecycle/variants';
import { planTransfer } from '@/features/inventory/stock';
import {
  batchKeyOf,
  isDefaultBatch,
  planBatchConsumption,
  planBatchSelection,
  type BatchIdentity,
} from '@/features/inventory/batches';
import { BaseRepository } from './base';
import {
  DEFAULT_CAPABILITY_WEIGHT,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MS_PER_DAY,
  UNASSIGNED_LOCATION_ID,
} from './constants';
import { clampNetValue, weighInNote, weighInToDelta } from './gauge';
import { consolidateStockStatements, setStockStatement, stockRowId } from './stock';
import {
  addBatchStatement,
  consumeBatchStatements,
  placementDeltaStatements,
  readPlacementBatches,
  setBatchStatement,
  stockBatchRowId,
} from './stock-batches';
import { tombstoneStatement } from './tombstone';
import { rowToCapability, rowToHistoryEntry, rowToItem, rowToItemAlias } from './mappers';
import type {
  Capability,
  CapabilityKeySummary,
  CapabilityRow,
  CreateItemInput,
  GaugeAdjustment,
  Item,
  ItemAlias,
  ItemAliasRow,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemRow,
  ItemStockPlacement,
  LowStockThresholds,
  Page,
  PageParams,
  ReconciliationAdjustment,
  ScrapeApplyInput,
  SerialisedReconciliation,
  SetCapabilityInput,
  UpdateItemInput,
} from './types';

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

export interface ItemListFilters extends PageParams {
  readonly locationId?: string;
  readonly categoryId?: string;
  /** Free-text match across name/description/mpn/manufacturer via FTS5 (spec §5). */
  readonly search?: string;
  /** Include soft-deleted items. Defaults to false (active inventory only). */
  readonly includeInactive?: boolean;
}

/** Pagination + scope for a Visual-Builder AST search (spec §5.1). */
export interface SearchByAstParams extends PageParams {
  /** Include soft-deleted items. Defaults to false (active inventory only). */
  readonly includeInactive?: boolean;
}

/**
 * A correlated subquery yielding an item's *primary* thumbnail blob (lowest
 * `position`) and nothing else from `item_images` (spec §4.2.4: list/detail reads
 * JOIN the image table but select the thumbnail only — never the full-res path).
 */
const THUMBNAIL_SUBQUERY = `(
  SELECT thumbnail_blob FROM item_images
  WHERE item_images.item_id = items.id
  ORDER BY position ASC, rowid ASC LIMIT 1
) AS thumbnail_blob`;

/**
 * A correlated subquery yielding an item's "best match" relevance score (spec §4,
 * §5.1): the summed `weight` of the queried capabilities the item actually carries.
 * The `keyCount` placeholders are bound to the de-duplicated capability keys the AST
 * filters on (case-insensitive). An item missing every queried capability scores 0.
 */
function capabilityMatchScore(keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => '?').join(', ');
  return `(
    SELECT COALESCE(SUM(c.weight), 0) FROM capabilities c
    WHERE c.item_id = items.id AND c.key COLLATE NOCASE IN (${placeholders})
  ) AS match_score`;
}

export class ItemRepository extends BaseRepository {
  async getById(id: string): Promise<Item | undefined> {
    const row = await this.driver.queryOne<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items WHERE id = ?;`,
      [id],
    );
    return row ? rowToItem(row) : undefined;
  }

  /** A paginated, filtered list of items (spec §2.1). */
  async list(filters: ItemListFilters = {}): Promise<Page<Item>> {
    const { limit, offset } = this.resolvePage(filters);
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (!filters.includeInactive) where.push('is_active = 1');
    if (filters.locationId) {
      where.push('location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.categoryId) {
      where.push('category_id = ?');
      params.push(filters.categoryId);
    }
    if (filters.search && filters.search.trim().length > 0) {
      // FTS5 full-text match over the indexed item columns (spec §5, §2.2.1a) —
      // the genuine search backend, never a LIKE scan. `null` = no usable tokens.
      const match = buildFtsMatch(filters.search.trim());
      if (match !== null) {
        where.push('items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
        params.push(match);
      }
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items ${clause}
       ORDER BY name COLLATE NOCASE ASC, serial_no ASC, created_at ASC
       LIMIT ? OFFSET ?;`,
      params,
    );
    return this.toPage(rows.map(rowToItem), limit, offset);
  }

  /** Count items matching a filter (for pagination headers / dashboard widgets). */
  async count(filters: Omit<ItemListFilters, 'limit' | 'offset'> = {}): Promise<number> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (!filters.includeInactive) where.push('is_active = 1');
    if (filters.locationId) {
      where.push('location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.categoryId) {
      where.push('category_id = ?');
      params.push(filters.categoryId);
    }
    if (filters.search && filters.search.trim().length > 0) {
      // FTS5 full-text match over the indexed item columns (spec §5, §2.2.1a) —
      // the genuine search backend, never a LIKE scan. `null` = no usable tokens.
      const match = buildFtsMatch(filters.search.trim());
      if (match !== null) {
        where.push('items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
        params.push(match);
      }
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${clause};`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  async create(input: CreateItemInput): Promise<Item> {
    this.assertWritable();
    const resolved = this.resolveCreate(input);
    const id = crypto.randomUUID();
    await this.driver.transaction(this.buildInsert(id, resolved, null));
    return (await this.getById(id))!;
  }

  /**
   * Create N distinct SERIALISED instance records that share a name (spec §4
   * "Serialised" auto-clone). Each record gets quantity 1 and a serial number
   * 1..N, and logs its own CREATED entry, all in one atomic transaction. A `count`
   * of 1 (or omitted) yields a single instance #1. Write-gated.
   */
  async createSerialised(input: CreateItemInput): Promise<Item[]> {
    this.assertWritable();
    const count = Math.max(1, Math.floor(input.count ?? 1));
    const resolved = this.resolveCreate({ ...input, trackingMode: 'SERIALISED' });

    const ids: string[] = [];
    const statements: SqlStatement[] = [];
    for (let serial = 1; serial <= count; serial += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      statements.push(...this.buildInsert(id, resolved, serial));
    }
    await this.driver.transaction(statements);

    const created = await Promise.all(ids.map((id) => this.getById(id)));
    return created.filter((i): i is Item => i !== undefined);
  }

  async update(id: string, input: UpdateItemInput): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const statements: SqlStatement[] = [];

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'An item must have a name.');
      }
      if (name !== existing.name) {
        sets.push('name = ?');
        params.push(name);
        statements.push(
          historyStatement(id, 'RENAMED', { note: `Renamed "${existing.name}" → "${name}".` }),
        );
      }
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (input.categoryId !== undefined) {
      sets.push('category_id = ?');
      params.push(input.categoryId);
    }
    if (input.mpn !== undefined) {
      sets.push('mpn = ?');
      params.push(normaliseText(input.mpn));
    }
    if (input.manufacturer !== undefined) {
      sets.push('manufacturer = ?');
      params.push(normaliseText(input.manufacturer));
    }
    if (input.unitCost !== undefined) {
      sets.push('unit_cost = ?');
      params.push(normaliseUnitCost(input.unitCost));
    }
    if (input.expiryDate !== undefined) {
      sets.push('expiry_date = ?');
      params.push(normaliseExpiry(input.expiryDate));
    }
    if (input.batchNumber !== undefined) {
      sets.push('batch_number = ?');
      params.push(normaliseText(input.batchNumber));
    }
    if (input.lotNumber !== undefined) {
      sets.push('lot_number = ?');
      params.push(normaliseText(input.lotNumber));
    }
    if (input.condition !== undefined && input.condition !== existing.condition) {
      sets.push('condition = ?');
      params.push(input.condition);
      statements.push(
        historyStatement(id, 'CONDITION_CHANGED', {
          note: `Condition changed ${existing.condition ? `from "${existing.condition}" ` : ''}to "${input.condition ?? 'untracked'}".`,
          metadata: { from: existing.condition, to: input.condition },
        }),
      );
    }
    if (input.operationalMetadata !== undefined) {
      // §4.1.1 schema-less map; an empty/cleared set stores SQL NULL. Serialised here
      // (mirroring the create path) so the db layer holds no feature-layer imports.
      sets.push('operational_metadata = ?');
      params.push(
        input.operationalMetadata && Object.keys(input.operationalMetadata).length > 0
          ? JSON.stringify(input.operationalMetadata)
          : null,
      );
    }

    if (sets.length > 0) {
      params.push(id);
      await this.driver.transaction([
        { sql: `UPDATE items SET ${sets.join(', ')} WHERE id = ?;`, params },
        ...statements,
      ]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Move an item *wholesale* to another location, logging the move (spec §4 Activity
   * Log). Every per-location placement is consolidated into the target (Phase 25), so
   * an item split across drawers is brought back together; `location_id` (the item's
   * primary/home location) follows. Use {@link transferStock} to move *part* of an
   * item's stock to a second location while keeping the rest where it is.
   */
  async move(id: string, locationId: string): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);
    if (existing.locationId === locationId) return existing;

    const target = await this.driver.queryOne('SELECT 1 AS ok FROM locations WHERE id = ?;', [
      locationId,
    ]);
    if (!target) {
      throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Location "${locationId}" does not exist.`);
    }

    await this.driver.transaction([
      ...consolidateStockStatements(id, locationId),
      { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [locationId, id] },
      historyStatement(id, 'MOVED', {
        note: 'Moved to a new location.',
        metadata: { fromLocationId: existing.locationId, toLocationId: locationId },
      }),
    ]);
    return (await this.getById(id))!;
  }

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
   * SERIALISED items are fixed at 1; gauge items use {@link adjustGauge}.
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

  /**
   * Apply a Consumable-Gauge adjustment as a relative delta (spec §4.1.2). Both
   * "Consumption" and "Weigh-In" UI modes are normalised to a delta *before*
   * reaching here, so the ledger only ever stores relative net-value deltas — the
   * representation Phase 7's delta-CRDT reconciliation (§7.3) depends on. The new
   * net value is clamped to the valid range `[0, grossCapacity]` — it can never go
   * below empty nor (after a refill/overfilled weigh-in) above a full unit.
   */
  async adjustGauge(id: string, adjustment: GaugeAdjustment): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);
    if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Gauge adjustment applies only to CONSUMABLE_GAUGE items.',
      );
    }
    if (!Number.isFinite(adjustment.delta)) {
      throw new DbError('SQLITE_CONSTRAINT', 'Gauge delta must be a finite number.');
    }

    const requestedNet = existing.gauge.currentNetValue + adjustment.delta;
    const nextNet = clampNetValue(requestedNet, existing.gauge.grossCapacity);
    const appliedDelta = nextNet - existing.gauge.currentNetValue;

    await this.driver.transaction([
      { sql: 'UPDATE items SET current_net_value = ? WHERE id = ?;', params: [nextNet, id] },
      historyStatement(id, 'GAUGE_UPDATE', {
        netValueDelta: appliedDelta,
        note:
          adjustment.note ??
          `Gauge ${appliedDelta >= 0 ? '+' : ''}${appliedDelta}${existing.gauge.unitOfMeasure} (now ${nextNet}${existing.gauge.unitOfMeasure}).`,
      }),
    ]);
    return (await this.getById(id))!;
  }

  /**
   * Convenience for an Absolute "Weigh-In" (§4.1.2): converts the gross weight on
   * the scale into a relative delta here so call sites cannot accidentally store an
   * absolute value. (The production UI converts in the React layer; this guards
   * the repository contract and is exercised by the gauge tests.)
   */
  async weighInGauge(id: string, grossWeightOnScale: number): Promise<Item> {
    const existing = await this.require(id);
    if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
      throw new DbError('SQLITE_CONSTRAINT', 'Weigh-in applies only to CONSUMABLE_GAUGE items.');
    }
    const delta = weighInToDelta(
      grossWeightOnScale,
      existing.gauge.currentNetValue,
      existing.gauge.tareWeight,
    );
    return this.adjustGauge(id, {
      delta,
      note: weighInNote(grossWeightOnScale, delta, existing.gauge.unitOfMeasure),
    });
  }

  /** Soft delete: mark inactive, preserving history (spec §4). Allowed when locked. */
  async softDelete(id: string, note?: string): Promise<Item> {
    const existing = await this.require(id);
    if (!existing.isActive) return existing;
    await this.driver.transaction([
      { sql: 'UPDATE items SET is_active = 0 WHERE id = ?;', params: [id] },
      historyStatement(id, 'SOFT_DELETED', { note: note ?? 'Marked as removed from active inventory.' }),
    ]);
    return (await this.getById(id))!;
  }

  async restore(id: string): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);
    if (existing.isActive) return existing;
    await this.driver.transaction([
      { sql: 'UPDATE items SET is_active = 1 WHERE id = ?;', params: [id] },
      historyStatement(id, 'RESTORED', { note: 'Restored to active inventory.' }),
    ]);
    return (await this.getById(id))!;
  }

  /**
   * Hard delete: permanently purge the item (spec §4). Cascades the Activity Log.
   * Allowed under the storage Hard Stop. Records a tombstone in the *same*
   * transaction so the deletion propagates on the next sync (§7.2).
   */
  async hardDelete(id: string): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM items WHERE id = ?;', params: [id] },
      tombstoneStatement('items', id),
    ]);
  }

  /** Paginated Activity Log for an item, newest first (spec §4.1.3). */
  async getHistory(itemId: string, params: PageParams = {}): Promise<Page<ItemHistoryEntry>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ItemHistoryRow>(
      // rowid is the deterministic insertion-order tiebreaker when several
      // entries share a created_at millisecond (e.g. create + first adjustment).
      `SELECT * FROM item_history WHERE item_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?;`,
      [itemId, limit, offset],
    );
    return this.toPage(rows.map(rowToHistoryEntry), limit, offset);
  }

  // --- aliases & BOM auto-match (spec §4 Universal Alias Mapping) -----------------

  /** Supplier/alternative part identifiers mapped to this item, alphabetically. */
  async listAliases(itemId: string): Promise<ItemAlias[]> {
    const rows = await this.driver.query<ItemAliasRow>(
      'SELECT * FROM item_aliases WHERE item_id = ? ORDER BY alias COLLATE NOCASE ASC;',
      [itemId],
    );
    return rows.map(rowToItemAlias);
  }

  /**
   * Replace an item's alias set with the supplied list, de-duplicated
   * case-insensitively. Trimmed-empty entries are dropped. Each alias is unique
   * across the table, so reassigning one already owned by another item is rejected.
   * Write-gated (it grows storage).
   *
   * Now that `item_aliases` participates in synchronisation (§7.1, it carries its own
   * `updated_at`), this is a **diff** rather than a wipe-and-reinsert: retained
   * aliases keep their stable id (so LWW timestamps stay meaningful) and each removed
   * alias records a tombstone in the *same* transaction, so the deletion propagates on
   * the next sync instead of being resurrected from a peer (§7.2).
   */
  async setAliases(itemId: string, aliases: readonly string[]): Promise<ItemAlias[]> {
    this.assertWritable();
    await this.require(itemId);

    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of aliases) {
      const alias = raw.trim();
      if (alias.length === 0) continue;
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(alias);
    }

    const existing = await this.listAliases(itemId);
    const existingByKey = new Map(existing.map((a) => [a.alias.toLowerCase(), a]));
    const desiredKeys = new Set(cleaned.map((a) => a.toLowerCase()));

    const statements: SqlStatement[] = [];
    // Removals: existing aliases no longer wanted → DELETE + tombstone (atomically).
    for (const alias of existing) {
      if (!desiredKeys.has(alias.alias.toLowerCase())) {
        statements.push({ sql: 'DELETE FROM item_aliases WHERE id = ?;', params: [alias.id] });
        statements.push(tombstoneStatement('item_aliases', alias.id));
      }
    }
    // Additions: genuinely-new aliases → INSERT a fresh id (retained ones untouched).
    for (const alias of cleaned) {
      if (!existingByKey.has(alias.toLowerCase())) {
        statements.push({
          sql: 'INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);',
          params: [crypto.randomUUID(), itemId, alias],
        });
      }
    }

    if (statements.length > 0) await this.driver.transaction(statements);
    return this.listAliases(itemId);
  }

  /**
   * Atomically apply an external-scrape merge to an existing item (spec §4, §9).
   * Only the fields the caller decided to write are touched — the §4 no-overwrite
   * safeguard is enforced *before* this call by the pure merge engine — and the
   * supplier MPN(s) are mapped in as new aliases (§4 Universal Alias Mapping). The
   * field UPDATE, the alias INSERTs and the `SCRAPE_APPLIED` ledger entry all run in
   * one transaction, so the merge is all-or-nothing. Write-gated (it grows storage).
   * A no-op write returns the item unchanged without logging.
   */
  async applyScrape(id: string, write: ScrapeApplyInput): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const changed: string[] = [];

    if (write.fields.mpn !== undefined) {
      sets.push('mpn = ?');
      params.push(normaliseText(write.fields.mpn));
      changed.push('MPN');
    }
    if (write.fields.manufacturer !== undefined) {
      sets.push('manufacturer = ?');
      params.push(normaliseText(write.fields.manufacturer));
      changed.push('manufacturer');
    }
    if (write.fields.unitCost !== undefined) {
      sets.push('unit_cost = ?');
      params.push(normaliseUnitCost(write.fields.unitCost));
      changed.push('unit cost');
    }
    if (write.fields.description !== undefined) {
      sets.push('description = ?');
      params.push(write.fields.description);
      changed.push('description');
    }

    const statements: SqlStatement[] = [];
    if (sets.length > 0) {
      statements.push({ sql: `UPDATE items SET ${sets.join(', ')} WHERE id = ?;`, params: [...params, id] });
    }
    for (const raw of write.aliasAdditions) {
      const alias = raw.trim();
      if (alias.length === 0) continue;
      statements.push({
        sql: 'INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);',
        params: [crypto.randomUUID(), id, alias],
      });
      changed.push(`alias "${alias}"`);
    }

    if (statements.length === 0) return existing;

    statements.push(
      historyStatement(id, 'SCRAPE_APPLIED', { note: `Applied scraped supplier data: ${changed.join(', ')}.` }),
    );
    await this.driver.transaction(statements);
    return (await this.getById(id))!;
  }

  /**
   * Resolve a BOM match key to a local item: first by exact (case-insensitive) MPN,
   * then by an alias mapping (§4). Returns undefined when nothing matches, so the
   * importer can leave the BOM line unmatched.
   */
  async findByMatchKey(key: string): Promise<Item | undefined> {
    const trimmed = key.trim();
    if (trimmed.length === 0) return undefined;

    const byMpn = await this.driver.queryOne<{ id: string }>(
      'SELECT id FROM items WHERE mpn = ? COLLATE NOCASE LIMIT 1;',
      [trimmed],
    );
    if (byMpn) return this.getById(byMpn.id);

    const byAlias = await this.driver.queryOne<{ item_id: string }>(
      'SELECT item_id FROM item_aliases WHERE alias = ? COLLATE NOCASE LIMIT 1;',
      [trimmed],
    );
    return byAlias ? this.getById(byAlias.item_id) : undefined;
  }

  // --- weighted capabilities (spec §4 Weighted Capabilities, Phase 5) -------------

  /** An item's capabilities, ordered by key (case-insensitive). */
  async listCapabilities(itemId: string): Promise<Capability[]> {
    const rows = await this.driver.query<CapabilityRow>(
      'SELECT * FROM capabilities WHERE item_id = ? ORDER BY key COLLATE NOCASE ASC;',
      [itemId],
    );
    return rows.map(rowToCapability);
  }

  /**
   * Add or replace a capability keyed by (item, key). The raw value is classified
   * into a numeric magnitude (backing >/< comparisons) when it parses as a finite
   * number, otherwise a text value (backing EQUALS/categorical matches). One value
   * per key, so re-setting the same key overwrites it. Write-gated (it grows storage).
   */
  async setCapability(itemId: string, input: SetCapabilityInput): Promise<Capability> {
    this.assertWritable();
    await this.require(itemId);

    const key = input.key.trim();
    if (key.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A capability must have a key.');
    }
    const weight = input.weight ?? DEFAULT_CAPABILITY_WEIGHT;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'Capability weight must be a non-negative number.');
    }

    const raw = input.value.trim();
    const num = Number(raw);
    const isNumeric = raw.length > 0 && Number.isFinite(num);
    const valueNum = isNumeric ? num : null;
    const valueText = isNumeric ? null : raw.length > 0 ? raw : null;

    const id = crypto.randomUUID();
    await this.driver.transaction([
      // Replace any existing value for this key (case-insensitive) — one per (item,key).
      {
        sql: 'DELETE FROM capabilities WHERE item_id = ? AND key = ? COLLATE NOCASE;',
        params: [itemId, key],
      },
      {
        sql: `INSERT INTO capabilities (id, item_id, key, value_num, value_text, weight)
              VALUES (?, ?, ?, ?, ?, ?);`,
        params: [id, itemId, key, valueNum, valueText, weight],
      },
    ]);
    const row = await this.driver.queryOne<CapabilityRow>(
      'SELECT * FROM capabilities WHERE id = ?;',
      [id],
    );
    return rowToCapability(row!);
  }

  /**
   * The distinct capability *keys* carried across active inventory — the queryable
   * `cap:<key>` vocabulary (spec §4, §5.1) — paginated, busiest key first. For each key
   * it reports how many active items carry it and whether the stored values are numeric
   * (supporting `cap:key>n`) and/or textual (supporting `cap:key=value`). Read-only and
   * static parameterised SQL; one value per (item, key), so `itemCount` is also the row
   * count per key. Powers a "browse capabilities" view and the read-only query bridge.
   */
  async listCapabilityKeys(params: PageParams = {}): Promise<Page<CapabilityKeySummary>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<{
      key: string;
      item_count: number;
      numeric_count: number;
      text_count: number;
    }>(
      `SELECT c.key AS key,
              COUNT(DISTINCT c.item_id) AS item_count,
              SUM(CASE WHEN c.value_num IS NOT NULL THEN 1 ELSE 0 END) AS numeric_count,
              SUM(CASE WHEN c.value_text IS NOT NULL THEN 1 ELSE 0 END) AS text_count
       FROM capabilities c
       JOIN items i ON i.id = c.item_id AND i.is_active = 1
       GROUP BY c.key COLLATE NOCASE
       ORDER BY item_count DESC, c.key COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({
        key: r.key,
        itemCount: Number(r.item_count),
        hasNumericValues: Number(r.numeric_count) > 0,
        hasTextValues: Number(r.text_count) > 0,
      })),
      limit,
      offset,
    );
  }

  /** Remove a capability by key (case-insensitive). Deletions bypass the Hard Stop. */
  async removeCapability(itemId: string, key: string): Promise<void> {
    await this.driver.execute(
      'DELETE FROM capabilities WHERE item_id = ? AND key = ? COLLATE NOCASE;',
      [itemId, key.trim()],
    );
  }

  // --- Visual-Builder search (spec §5.1) -----------------------------------------

  /**
   * Run a Visual-Builder {@link SearchAST} as a paginated item query. The AST is
   * translated by the single parameterised {@link parseASTtoSQL} utility (§5.1) and
   * scoped to active inventory unless `includeInactive` is set. Throws
   * `SearchAstError` on an invalid/over-deep tree.
   */
  async searchByAst(ast: SearchAST, params: SearchByAstParams = {}): Promise<Page<Item>> {
    const { limit, offset } = this.resolvePage(params);
    const [where, whereParams] = parseASTtoSQL(ast);
    const active = params.includeInactive ? '' : ' AND items.is_active = 1';

    // Weighted-capability "best match" ranking (spec §4, §5.1): when the query
    // filters on one or more `capability:<key>` fields, order results by the summed
    // weight of *those* capabilities each item carries — heaviest matches first —
    // before the stable alphabetical tie-break. A query with no capability conditions
    // keeps the plain alphabetical order untouched (zero behavioural change).
    const capabilityKeys = collectCapabilityKeys(ast);
    const rankSelect = capabilityKeys.length > 0 ? `, ${capabilityMatchScore(capabilityKeys.length)}` : '';
    const rankParams = capabilityKeys.length > 0 ? capabilityKeys : [];
    const rankOrder = capabilityKeys.length > 0 ? 'match_score DESC, ' : '';

    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY}${rankSelect} FROM items WHERE (${where})${active}
       ORDER BY ${rankOrder}name COLLATE NOCASE ASC, serial_no ASC, created_at ASC
       LIMIT ? OFFSET ?;`,
      [...rankParams, ...whereParams, limit, offset],
    );
    return this.toPage(rows.map(rowToItem), limit, offset);
  }

  /** Count items matching a {@link SearchAST} (for result headers). */
  async countByAst(ast: SearchAST, params: { includeInactive?: boolean } = {}): Promise<number> {
    const [where, whereParams] = parseASTtoSQL(ast);
    const active = params.includeInactive ? '' : ' AND items.is_active = 1';
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items WHERE (${where})${active};`,
      whereParams,
    );
    return Number(row?.n ?? 0);
  }

  // --- Parent/Child variants (spec §4 Variant/SKU, Phase 9) ----------------------

  /** The child variants of a parent item, ordered by name then serial (spec §4). */
  async listVariants(parentId: string): Promise<Page<Item>> {
    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items WHERE parent_id = ?
       ORDER BY name COLLATE NOCASE ASC, serial_no ASC, created_at ASC;`,
      [parentId],
    );
    // Variant lists are inherently small (one SKU's variants); no offset needed.
    return this.toPage(rows.map(rowToItem), rows.length || 1, 0);
  }

  /**
   * Create a child variant under an existing parent (spec §4 Variant/SKU). The
   * parent holds shared metadata; the variant carries its own qty/location. Phase 18
   * lifts the single-level cap: the parent may itself be a variant (nesting is free),
   * so the only structural check before the INSERT is that the parent exists. The
   * brand-new id cannot create a cycle. Write-gated.
   */
  async createVariant(parentId: string, input: CreateItemInput): Promise<Item> {
    this.assertWritable();
    const id = crypto.randomUUID();
    await this.assertVariantLinkValid(id, parentId);
    const resolved = this.resolveCreate(input);
    await this.driver.transaction(this.buildInsert(id, resolved, null, parentId));
    return (await this.getById(id))!;
  }

  /**
   * Attach an existing item to a parent as a variant, or detach it (parentId null).
   * Phase 18 allows arbitrarily-deep nesting, so the only structural rule enforced is
   * cycle/self-parent rejection (§7.5.3) — checked against the parent's full ancestor
   * chain before writing. An item that already has its own variants may now become a
   * variant too (it carries its sub-tree along). Write-gated.
   */
  async setParent(childId: string, parentId: string | null): Promise<Item> {
    this.assertWritable();
    const child = await this.require(childId);
    if (parentId === child.parentId) return child;

    const statements: SqlStatement[] = [];
    if (parentId === null) {
      statements.push({ sql: 'UPDATE items SET parent_id = NULL WHERE id = ?;', params: [childId] });
    } else {
      await this.assertVariantLinkValid(childId, parentId);
      statements.push({ sql: 'UPDATE items SET parent_id = ? WHERE id = ?;', params: [parentId, childId] });
      statements.push(
        historyStatement(childId, 'VARIANT_CREATED', { note: 'Attached as a variant of a parent item.' }),
      );
    }
    await this.driver.transaction(statements);
    return (await this.getById(childId))!;
  }

  // --- Perishables (spec §4 Expiry & Batch tracking, §3 "Soon to Expire") --------

  /**
   * Active perishable items expiring on or before `before` (a UNIX-ms cutoff,
   * typically `now + N days`), soonest first — the §3 "Soon to Expire" widget feed.
   * Already-expired items are included (their expiry is in the past, ≤ cutoff).
   */
  async listExpiring(before: number, params: PageParams = {}): Promise<Page<Item>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
       WHERE is_active = 1 AND expiry_date IS NOT NULL AND expiry_date <= ?
       ORDER BY expiry_date ASC LIMIT ? OFFSET ?;`,
      [before, limit, offset],
    );
    return this.toPage(rows.map(rowToItem), limit, offset);
  }

  /** Convenience: perishables expiring within `withinDays` of `now` (inclusive). */
  async listExpiringWithin(withinDays: number, now: number, params: PageParams = {}): Promise<Page<Item>> {
    return this.listExpiring(now + withinDays * MS_PER_DAY, params);
  }

  // --- Low stock (spec §3 "Low Stock Alerts" widget, §4) -------------------------

  /**
   * Active items running low — the §3 dashboard "Low Stock Alerts" feed, most
   * depleted first. A DISCRETE item is low when on-hand `quantity` is at/below
   * `qtyThreshold`; a CONSUMABLE_GAUGE item is low when its percentage remaining is
   * at/below `gaugePercent` (§4 "low-stock alerts based on percentage or remaining
   * weight rather than integer counts"). SERIALISED single assets are excluded (a
   * qty-1 asset isn't "low bulk stock"), as are **abstract variant parents** (an item
   * that has children holds no stock of its own — its variants do) and inactive items.
   * Ordering is by remaining *fraction* so the two tracking modes interleave by
   * urgency. Thresholds default to {@link LOW_STOCK_QTY_THRESHOLD} / {@link LOW_STOCK_GAUGE_PERCENT}.
   */
  async listLowStock(thresholds: LowStockThresholds = {}, params: PageParams = {}): Promise<Page<Item>> {
    const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
    const pct = thresholds.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
       WHERE is_active = 1
         AND id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)
         AND (
           (tracking_mode = 'DISCRETE' AND quantity <= ?)
           OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0
               AND current_net_value <= gross_capacity * ? / 100.0)
         )
       ORDER BY
         CASE WHEN tracking_mode = 'CONSUMABLE_GAUGE' THEN current_net_value / gross_capacity
              ELSE CAST(quantity AS REAL) / ? END ASC,
         name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [qty, pct, qty, limit, offset],
    );
    return this.toPage(rows.map(rowToItem), limit, offset);
  }

  // --- Cycle counting & reconciliation (spec §4.4, Phase 9) ----------------------

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
   * {@link restore}) and logged as `RECONCILED` with a `quantity_delta` of −1 (the
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

  // --- internals -----------------------------------------------------------------

  /**
   * Guard a proposed `child → parent` variant link (spec §4, §7.5.3). The parent
   * must exist; the link must not be self-parenting or form a cycle (the child
   * appearing in the parent's ancestor chain). Nesting depth is unbounded (Phase 18),
   * so this mirrors `LocationRepository.assertParentMoveValid`: walk up from the
   * proposed parent via a recursive CTE and let the pure `validateVariantLink`
   * decide. Throws a `DbError` on rejection.
   */
  private async assertVariantLinkValid(childId: string, parentId: string): Promise<void> {
    const parentExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [parentId]);
    if (!parentExists) {
      throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Parent item "${parentId}" does not exist.`);
    }

    // The proposed parent's ancestor chain (parent, grandparent, …) — a cycle exists
    // if the child being attached appears anywhere in it.
    const ancestorRows = await this.driver.query<{ id: string }>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION ALL
         SELECT i.parent_id FROM items i
         JOIN ancestors a ON i.id = a.id
         WHERE i.parent_id IS NOT NULL
       )
       SELECT id FROM ancestors;`,
      [parentId],
    );

    const rejection = validateVariantLink({
      childId,
      parentId,
      parentAncestorIds: ancestorRows.map((r) => r.id),
    });
    if (rejection) {
      throw new DbError('SQLITE_CONSTRAINT', variantRejectionMessage(rejection));
    }
  }

  private async require(id: string): Promise<Item> {
    const item = await this.getById(id);
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${id}" does not exist.`);
    }
    return item;
  }

  /** Validate and normalise creation input into the concrete column values. */
  private resolveCreate(input: CreateItemInput): ResolvedCreate {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'An item must have a name.');
    }

    const trackingMode = input.trackingMode ?? 'DISCRETE';
    const locationId = input.locationId ?? UNASSIGNED_LOCATION_ID;

    let quantity = input.quantity ?? (trackingMode === 'SERIALISED' ? 1 : 0);
    if (trackingMode === 'SERIALISED') quantity = 1;
    if (quantity < 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'Quantity cannot be negative.');
    }

    let unit: string | null = null;
    let grossCapacity: number | null = null;
    let tareWeight: number | null = null;
    let netValue: number | null = null;
    let operationalMetadata: string | null = null;

    if (trackingMode === 'CONSUMABLE_GAUGE') {
      const gauge = input.gauge;
      if (!gauge || !gauge.unitOfMeasure || !(gauge.grossCapacity > 0)) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          'A Consumable-Gauge item requires a unit of measure and a positive gross capacity.',
        );
      }
      unit = gauge.unitOfMeasure;
      grossCapacity = gauge.grossCapacity;
      tareWeight = gauge.tareWeight ?? 0;
      netValue = gauge.currentNetValue ?? gauge.grossCapacity;
      if (tareWeight < 0 || netValue < 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge weights cannot be negative.');
      }
      operationalMetadata = gauge.operationalMetadata
        ? JSON.stringify(gauge.operationalMetadata)
        : null;
    }

    return {
      name,
      description: input.description ?? null,
      locationId,
      categoryId: input.categoryId ?? null,
      mpn: normaliseText(input.mpn),
      manufacturer: normaliseText(input.manufacturer),
      unitCost: normaliseUnitCost(input.unitCost),
      expiryDate: normaliseExpiry(input.expiryDate),
      batchNumber: normaliseText(input.batchNumber),
      lotNumber: normaliseText(input.lotNumber),
      condition: input.condition ?? null,
      trackingMode,
      quantity,
      unit,
      grossCapacity,
      tareWeight,
      netValue,
      operationalMetadata,
    };
  }

  /** Build the INSERT + CREATED-log statement pair for one item record. */
  private buildInsert(
    id: string,
    r: ResolvedCreate,
    serialNo: number | null,
    parentId: string | null = null,
  ): SqlStatement[] {
    return [
      {
        sql: `INSERT INTO items
                (id, name, description, location_id, category_id, tracking_mode, quantity, serial_no,
                 unit_of_measure, gross_capacity, tare_weight, current_net_value, operational_metadata,
                 mpn, manufacturer, unit_cost, expiry_date, batch_number, lot_number, condition, parent_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        params: [
          id,
          r.name,
          r.description,
          r.locationId,
          r.categoryId,
          r.trackingMode,
          r.quantity,
          serialNo,
          r.unit,
          r.grossCapacity,
          r.tareWeight,
          r.netValue,
          r.operationalMetadata,
          r.mpn,
          r.manufacturer,
          r.unitCost,
          r.expiryDate,
          r.batchNumber,
          r.lotNumber,
          r.condition,
          parentId,
        ],
      },
      // Seed the item's primary placement in the per-location ledger (Phase 25). The
      // recompute trigger then keeps `items.quantity` equal to this (and any future
      // placements). Runs after the items INSERT so the FK + trigger resolve.
      setStockStatement(id, r.locationId, r.quantity),
      historyStatement(id, parentId === null ? 'CREATED' : 'VARIANT_CREATED', {
        note:
          parentId !== null
            ? `Created variant "${r.name}".`
            : serialNo === null
              ? `Created "${r.name}".`
              : `Created "${r.name}" #${serialNo}.`,
        metadata: { trackingMode: r.trackingMode, locationId: r.locationId },
      }),
    ];
  }
}

/** Normalised column values produced by {@link ItemRepository.resolveCreate}. */
interface ResolvedCreate {
  readonly name: string;
  readonly description: string | null;
  readonly locationId: string;
  readonly categoryId: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly unitCost: number | null;
  readonly expiryDate: number | null;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly condition: string | null;
  readonly trackingMode: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly grossCapacity: number | null;
  readonly tareWeight: number | null;
  readonly netValue: number | null;
  readonly operationalMetadata: string | null;
}

interface HistoryFields {
  readonly quantityDelta?: number;
  readonly netValueDelta?: number;
  readonly note?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Build an append-only Activity Log INSERT for inclusion in a write transaction. */
function historyStatement(
  itemId: string,
  action: string,
  fields: HistoryFields = {},
): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      action,
      fields.quantityDelta ?? null,
      fields.netValueDelta ?? null,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ],
  };
}

/** Trim a free-text field, collapsing blank/whitespace-only input to NULL. */
function normaliseText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate an optional unit cost: null clears it; otherwise it must be ≥ 0. */
function normaliseUnitCost(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Unit cost must be a non-negative number.');
  }
  return value;
}

/** Validate an optional expiry instant: null clears it; otherwise a finite UNIX-ms. */
function normaliseExpiry(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) {
    throw new DbError('SQLITE_CONSTRAINT', 'Expiry date must be a valid timestamp.');
  }
  return Math.trunc(value);
}
