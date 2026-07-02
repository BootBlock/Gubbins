/**
 * ItemRepository core (spec §2.1.1, §4, §4.1).
 *
 * The CRUD spine of the item repository plus the shared `getById`/`require`
 * internals every concern mixin builds on. Every mutation records an entry in the
 * immutable Activity Log (`item_history`) within the same atomic transaction, so the
 * ledger can never drift from the item state. Reads are strictly paginated (§2.1).
 * Storage-growing writes are gated by the Hard Stop; deletions are always permitted.
 */
import { DbError } from '../../errors';
import type { SqlStatement, SqlValue } from '../../rpc/driver';
import { buildFtsMatch } from '../../search/fts';
import { isConvertibleTrackingChange } from '../constants';
import { BaseRepository } from '../base';
import { consolidateStockStatements } from '../stock';
import { tombstoneStatement } from '../tombstone';
import { rowToHistoryEntry, rowToItem } from '../mappers';
import type {
  CreateItemInput,
  Item,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemRow,
  Page,
  PageParams,
  UpdateItemInput,
} from '../types';
import { historyStatement } from './history';
import {
  normaliseExpiry,
  normaliseIsoDate,
  normalisePurchasePrice,
  normaliseDepreciationMonths,
  normaliseReorderInt,
  normaliseReorderPercent,
  normaliseText,
  normaliseUnitCost,
} from './normalise';
import { buildInsert, resolveCreate } from './create';
import { THUMBNAIL_SUBQUERY } from './sql';

export interface ItemListFilters extends PageParams {
  readonly locationId?: string;
  readonly categoryId?: string;
  /** Free-text match across name/description/notes/mpn/manufacturer via FTS5 (spec §5). */
  readonly search?: string;
  /** Include soft-deleted items. Defaults to false (active inventory only). */
  readonly includeInactive?: boolean;
}

export class ItemCoreRepository extends BaseRepository {
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
    const [clause, params] = buildListFilter(filters);
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
    const [clause, params] = buildListFilter(filters);
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${clause};`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  async create(input: CreateItemInput): Promise<Item> {
    this.assertWritable();
    const resolved = resolveCreate(input);
    const id = crypto.randomUUID();
    await this.driver.transaction(buildInsert(id, resolved, null));
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
    const resolved = resolveCreate({ ...input, trackingMode: 'SERIALISED' });

    const ids: string[] = [];
    const statements: SqlStatement[] = [];
    for (let serial = 1; serial <= count; serial += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      statements.push(...buildInsert(id, resolved, serial));
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
        statements.push(historyStatement(id, 'RENAMED', { note: `Renamed "${existing.name}" → "${name}".` }));
      }
    }
    if (input.trackingMode !== undefined && input.trackingMode !== existing.trackingMode) {
      // Only the storage-identical DISCRETE ↔ UNTRACKED swap is allowed in place; both keep
      // their quantity + item_stock ledger row, so nothing migrates and the on-hand stock is
      // preserved (UNTRACKED just hides it). Any other change is a lossy row-split / column
      // migration and is rejected — the item must be recreated instead.
      if (!isConvertibleTrackingChange(existing.trackingMode, input.trackingMode)) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Cannot change tracking mode from "${existing.trackingMode}" to "${input.trackingMode}" ` +
            'after creation. Only Discrete and Untracked can be swapped in place; create a new item ' +
            'for Serialised or Consumable-Gauge.',
        );
      }
      sets.push('tracking_mode = ?');
      params.push(input.trackingMode);
      statements.push(
        historyStatement(id, 'TRACKING_CHANGED', {
          note: `Tracking changed from "${existing.trackingMode}" to "${input.trackingMode}".`,
          metadata: { from: existing.trackingMode, to: input.trackingMode },
        }),
      );
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (input.notes !== undefined) {
      sets.push('notes = ?');
      params.push(input.notes);
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
    if (input.reorderPoint !== undefined) {
      sets.push('reorder_point = ?');
      params.push(normaliseReorderInt(input.reorderPoint));
    }
    if (input.reorderGaugePercent !== undefined) {
      sets.push('reorder_gauge_percent = ?');
      params.push(normaliseReorderPercent(input.reorderGaugePercent));
    }
    if (input.reorderQty !== undefined) {
      sets.push('reorder_qty = ?');
      params.push(normaliseReorderInt(input.reorderQty));
    }
    if (input.acquiredAt !== undefined) {
      sets.push('acquired_at = ?');
      params.push(normaliseIsoDate(input.acquiredAt));
    }
    if (input.warrantyExpiresAt !== undefined) {
      sets.push('warranty_expires_at = ?');
      params.push(normaliseIsoDate(input.warrantyExpiresAt));
    }
    if (input.purchasePrice !== undefined) {
      sets.push('purchase_price = ?');
      params.push(normalisePurchasePrice(input.purchasePrice));
    }
    if (input.depreciationMonths !== undefined) {
      sets.push('depreciation_months = ?');
      params.push(normaliseDepreciationMonths(input.depreciationMonths));
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
   * primary/home location) follows. Use `transferStock` to move *part* of an item's
   * stock to a second location while keeping the rest where it is.
   */
  async move(id: string, locationId: string): Promise<Item> {
    this.assertWritable();
    const existing = await this.require(id);
    if (existing.locationId === locationId) return existing;

    const target = await this.driver.queryOne('SELECT 1 AS ok FROM locations WHERE id = ?;', [locationId]);
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

  /** Fetch an item or throw a constraint error — the shared mutation precondition. */
  protected async require(id: string): Promise<Item> {
    const item = await this.getById(id);
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${id}" does not exist.`);
    }
    return item;
  }
}

/**
 * Build the shared `WHERE` clause + bound params for {@link ItemCoreRepository.list}
 * and {@link ItemCoreRepository.count} (location/category scope + FTS5 search). An
 * empty filter yields an empty clause.
 */
function buildListFilter(
  filters: Omit<ItemListFilters, 'limit' | 'offset'>,
): [clause: string, params: SqlValue[]] {
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
  return [clause, params];
}
