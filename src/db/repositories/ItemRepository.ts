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
import { BaseRepository } from './base';
import { UNASSIGNED_LOCATION_ID } from './constants';
import { weighInNote, weighInToDelta } from './gauge';
import { rowToHistoryEntry, rowToItem } from './mappers';
import type {
  CreateItemInput,
  GaugeAdjustment,
  Item,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemRow,
  Page,
  PageParams,
  UpdateItemInput,
} from './types';

export interface ItemListFilters extends PageParams {
  readonly locationId?: string;
  readonly categoryId?: string;
  /** Free-text name match (FTS5 arrives in Phase 5; this is a simple LIKE). */
  readonly search?: string;
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
      where.push('name LIKE ? ESCAPE ?');
      params.push(`%${escapeLike(filters.search.trim())}%`, '\\');
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
      where.push('name LIKE ? ESCAPE ?');
      params.push(`%${escapeLike(filters.search.trim())}%`, '\\');
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

    if (sets.length > 0) {
      params.push(id);
      await this.driver.transaction([
        { sql: `UPDATE items SET ${sets.join(', ')} WHERE id = ?;`, params },
        ...statements,
      ]);
    }
    return (await this.getById(id))!;
  }

  /** Move an item to another location, logging the move (spec §4 Activity Log). */
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
      { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [locationId, id] },
      historyStatement(id, 'MOVED', {
        note: 'Moved to a new location.',
        metadata: { fromLocationId: existing.locationId, toLocationId: locationId },
      }),
    ]);
    return (await this.getById(id))!;
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

    await this.driver.transaction([
      { sql: 'UPDATE items SET quantity = ? WHERE id = ?;', params: [next, id] },
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
   * net value is clamped at zero.
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
    const nextNet = Math.max(0, requestedNet);
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
   * Allowed under the storage Hard Stop. (Phase 7 will add tombstones for sync.)
   */
  async hardDelete(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM items WHERE id = ?;', [id]);
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

  // --- internals -----------------------------------------------------------------

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
  private buildInsert(id: string, r: ResolvedCreate, serialNo: number | null): SqlStatement[] {
    return [
      {
        sql: `INSERT INTO items
                (id, name, description, location_id, category_id, tracking_mode, quantity, serial_no,
                 unit_of_measure, gross_capacity, tare_weight, current_net_value, operational_metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        ],
      },
      historyStatement(id, 'CREATED', {
        note: serialNo === null ? `Created "${r.name}".` : `Created "${r.name}" #${serialNo}.`,
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

/** Escape LIKE wildcards so user input is matched literally (ESCAPE '\\'). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
