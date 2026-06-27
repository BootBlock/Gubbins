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
import { parseASTtoSQL } from '../search/parseASTtoSQL';
import type { SearchAST } from '../search/ast';
import { BaseRepository } from './base';
import { DEFAULT_CAPABILITY_WEIGHT, MS_PER_DAY, UNASSIGNED_LOCATION_ID } from './constants';
import { weighInNote, weighInToDelta } from './gauge';
import { tombstoneStatement } from './tombstone';
import { rowToCapability, rowToHistoryEntry, rowToItem, rowToItemAlias } from './mappers';
import type {
  Capability,
  CapabilityRow,
  CreateItemInput,
  GaugeAdjustment,
  Item,
  ItemAlias,
  ItemAliasRow,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemRow,
  Page,
  PageParams,
  ReconciliationAdjustment,
  ScrapeApplyInput,
  SetCapabilityInput,
  UpdateItemInput,
} from './types';

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
    const rows = await this.driver.query<ItemRow>(
      `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items WHERE (${where})${active}
       ORDER BY name COLLATE NOCASE ASC, serial_no ASC, created_at ASC
       LIMIT ? OFFSET ?;`,
      [...whereParams, limit, offset],
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
   * parent holds shared metadata; the variant carries its own qty/location. The
   * single-level rule is enforced here (the chosen parent must not itself be a
   * variant) before the INSERT, mirroring the §7.5.3 guard discipline. Write-gated.
   */
  async createVariant(parentId: string, input: CreateItemInput): Promise<Item> {
    this.assertWritable();
    await this.assertVariantParent(parentId);
    const resolved = this.resolveCreate(input);
    const id = crypto.randomUUID();
    await this.driver.transaction(this.buildInsert(id, resolved, null, parentId));
    return (await this.getById(id))!;
  }

  /**
   * Attach an existing item to a parent as a variant, or detach it (parentId null).
   * Enforces the single-level + no-cycle rules (§4, §7.5.3) before writing.
   * Write-gated.
   */
  async setParent(childId: string, parentId: string | null): Promise<Item> {
    this.assertWritable();
    const child = await this.require(childId);
    if (parentId === child.parentId) return child;

    const statements: SqlStatement[] = [];
    if (parentId === null) {
      statements.push({ sql: 'UPDATE items SET parent_id = NULL WHERE id = ?;', params: [childId] });
    } else {
      if (parentId === childId) {
        throw new DbError('SQLITE_CONSTRAINT', 'An item cannot be a variant of itself.');
      }
      await this.assertVariantParent(parentId);
      const hasVariants = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE parent_id = ? LIMIT 1;', [
        childId,
      ]);
      if (hasVariants) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          'This item already has its own variants and cannot become a variant.',
        );
      }
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

  // --- Cycle counting & reconciliation (spec §4.4, Phase 9) ----------------------

  /**
   * Apply a batch of authorised Reconciliation Adjustments (spec §4.4) atomically.
   * Each adjustment sets a DISCRETE item's on-hand quantity to the physically
   * counted value and records a `RECONCILED` ledger entry whose `quantity_delta` is
   * the variance (counted − previous) and whose note was composed upstream from the
   * blind count. The variance arithmetic itself lives in the pure cycle-count
   * module; this method trusts the decision, like `applyScrape`. Write-gated.
   * A zero-variance adjustment is skipped (no-op, not logged).
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
      const delta = adj.counted - existing.quantity;
      if (delta === 0) continue;
      statements.push({ sql: 'UPDATE items SET quantity = ? WHERE id = ?;', params: [adj.counted, adj.itemId] });
      statements.push(historyStatement(adj.itemId, 'RECONCILED', { quantityDelta: delta, note: adj.note }));
      touched.push(adj.itemId);
    }

    if (statements.length === 0) return [];
    await this.driver.transaction(statements);
    const updated = await Promise.all(touched.map((id) => this.getById(id)));
    return updated.filter((i): i is Item => i !== undefined);
  }

  // --- internals -----------------------------------------------------------------

  /**
   * Guard that `parentId` is a valid variant parent: it must exist and must not
   * itself be a variant (single-level model, §4). Throws a `DbError` otherwise.
   */
  private async assertVariantParent(parentId: string): Promise<void> {
    const parent = await this.driver.queryOne<{ parent_id: string | null }>(
      'SELECT parent_id FROM items WHERE id = ?;',
      [parentId],
    );
    if (!parent) {
      throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Parent item "${parentId}" does not exist.`);
    }
    if (parent.parent_id !== null) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The chosen parent is already a variant; variants cannot be nested.',
      );
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
