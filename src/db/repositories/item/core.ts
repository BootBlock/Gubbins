/**
 * ItemRepository core (spec §2.1.1, §4, §4.1).
 *
 * The CRUD spine of the item repository plus the shared `getById`/`require`
 * internals every concern mixin builds on. Every mutation records an entry in the
 * immutable Activity Log (`item_history`) within the same atomic transaction, so the
 * ledger can never drift from the item state. Reads are strictly paginated (§2.1).
 * Storage-growing writes are gated by the Hard Stop; deletions are always permitted.
 */
import { fromStoredMoney, toStoredMoney } from '@/lib/money';
import { isShortItemCode } from '@/features/scanner/scan-payload';
import { DbError } from '../../errors';
import type { SqlStatement, SqlValue } from '../../rpc/driver';
import { buildFtsMatch } from '../../search/fts';
import {
  isConvertibleTrackingChange,
  isValidSerialisedCount,
  SERIALISED_COUNT_BOUNDS,
  type TrackingMode,
} from '../constants';
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
import { TEXT_LIMITS } from '@/lib/text-limits';
import { assertTextLimit } from '../text-limits';
import { clearHistoryStatements, historyStatement } from './history';
import {
  buildSeekPredicate,
  extractCursor,
  renderOrderBy,
  resolveItemOrder,
  reverseOrder,
  type Cursor,
} from './list-order';
import {
  normaliseCurrentValue,
  normaliseExpiry,
  normaliseIsoDate,
  normalisePurchasePrice,
  normaliseDepreciationMonths,
  normaliseReorderInt,
  normaliseReorderPercent,
  normaliseText,
  normaliseCostPerUnitOfMeasure,
  normaliseUnitCost,
  normaliseWeight,
  normaliseDimension,
} from './normalise';
import { buildInsert, resolveCreate } from './create';
import { buildCategoryMaintenanceInsert, type CategoryMaintenanceDefault } from './maintenance-default';
import { ITEM_READ_COLUMNS, type ItemSort } from './sql';
import { buildStatusFilter, type ItemStatusFilter } from './status-filter';
import type { LowStockThresholds } from '../types';
import { nowMs } from '@/lib/clock';

/**
 * A keyset (seek) page request for the infinite-scroll list (issue #172) — the offset-free
 * alternative to `PageParams.offset`. `cursor` is the boundary row's ordering values (a prior
 * page's `endCursor` for `forward`, its `startCursor` for `backward`); `startIndex` is the
 * absolute index this page's first row occupies, echoed into `Page.offset` so the virtualised
 * list positions it exactly as an offset read would.
 */
export interface ItemSeek {
  readonly cursor: Cursor;
  readonly direction: 'forward' | 'backward';
  readonly startIndex: number;
}

export interface ItemListFilters extends PageParams {
  readonly locationId?: string;
  readonly categoryId?: string;
  /**
   * Restrict to items carrying **any** of these tag ids (a multi-select facet; OR within the
   * facet, AND with the other filters). Omitted or empty applies no tag filter.
   */
  readonly tagIds?: readonly string[];
  /**
   * Free-text match via FTS5 (spec §5), unscoped — so it searches **every** column `items_fts`
   * indexes (`FTS_ITEM_COLUMNS` in `repositories/constants`), not a subset.
   *
   * Named by reference rather than listed, because the list here had gone stale twice: it was an
   * accurate copy of a five-column index when written, then `barcode` and `serial_number` were
   * added to `items_fts` and nothing brought the comment along. Tests have proved both findable
   * through this very filter ever since, so the prose was the only thing that disagreed.
   */
  readonly search?: string;
  /** Include soft-deleted items. Defaults to false (active inventory only). */
  readonly includeInactive?: boolean;
  /** Explicit sort (whitelisted fields); omit to keep the default name/serial/created order. */
  readonly sort?: readonly ItemSort[];
  /**
   * Derived-status "attention" filters — low stock / expiring / overdue / maintenance due
   * (spec §3, §4). Multiple statuses are OR-combined (any concern matches). Omitted or empty
   * applies no status filtering. See {@link buildStatusFilter}.
   */
  readonly status?: readonly ItemStatusFilter[];
  /** Global low-stock fallback floors for the `'low-stock'` status; defaults to off (0). */
  readonly lowStockThresholds?: LowStockThresholds;
  /** Window (days) for the `'expiring'` status; defaults to the built-in soon-window. */
  readonly expirySoonWindowDays?: number;
  /**
   * Injected clock (UNIX-ms) for the time-based statuses (expiring / overdue / maintenance).
   * Omit outside tests — `list`/`count` stamp `nowMs()` at query time so the cutoff is
   * evaluated when the read runs, keeping `now` out of the query cache key.
   */
  readonly now?: number;
  /**
   * Keyset (seek) pagination for the infinite-scroll list (issue #172). When present, the page is
   * fetched by seeking past `seek.cursor` instead of by `offset` — so a deep page costs no more
   * than the first. Omit for the offset path (discrete pagination and the grouped sections).
   */
  readonly seek?: ItemSeek;
}

export class ItemCoreRepository extends BaseRepository {
  async getById(id: string): Promise<Item | undefined> {
    const row = await this.driver.queryOne<ItemRow>(`SELECT ${ITEM_READ_COLUMNS} FROM items WHERE id = ?;`, [
      id,
    ]);
    return row ? rowToItem(row) : undefined;
  }

  /**
   * Full item rows for a set of ids, in one round-trip, keyed by id (issue #70) — the checkout
   * dialog reads the items an outgoing loan *requires* so it can show each one's stock and lend
   * it alongside. Missing ids are simply absent from the map (an archived or deleted prerequisite
   * is a legitimate outcome, not an error); an empty set short-circuits.
   */
  async getManyById(ids: readonly string[]): Promise<Map<string, Item>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.driver.query<ItemRow>(
      `SELECT ${ITEM_READ_COLUMNS} FROM items WHERE id IN (${unique.map(() => '?').join(', ')});`,
      unique as SqlValue[],
    );
    return new Map(rows.map((row) => [row.id, rowToItem(row)]));
  }

  /**
   * Just the tracking mode of a set of items, keyed by id (issue #608) — what a screen needs to
   * know whether an action on each item will actually move stock, without asking for the items
   * themselves. Deliberately **not** {@link getManyById}: that projects `ITEM_READ_COLUMNS`,
   * which carries every item's thumbnail BLOB, and a table full of rows would pay for images it
   * never renders in order to read one enum. Missing ids are absent from the map; an empty set
   * short-circuits.
   */
  async getTrackingModes(ids: readonly string[]): Promise<Map<string, TrackingMode>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.driver.query<{ id: string; tracking_mode: TrackingMode }>(
      `SELECT id, tracking_mode FROM items WHERE id IN (${unique.map(() => '?').join(', ')});`,
      unique as SqlValue[],
    );
    return new Map(rows.map((row) => [row.id, row.tracking_mode]));
  }

  /**
   * Find the **active** item carrying a given retail barcode (GTIN), or `undefined`.
   * The scanner uses this to resolve a scanned EAN/UPC to an existing item before
   * offering to create one (recommendation point 1). The match is case-insensitive and
   * exact (barcodes are stored verbatim as printed); if several items share a barcode
   * the most recently created wins, so the result is deterministic. A blank barcode
   * never matches.
   */
  async getByBarcode(barcode: string): Promise<Item | undefined> {
    const value = barcode.trim();
    if (value.length === 0) return undefined;
    const row = await this.driver.queryOne<ItemRow>(
      `SELECT ${ITEM_READ_COLUMNS} FROM items
       WHERE barcode = ? COLLATE NOCASE AND is_active = 1
       ORDER BY created_at DESC, id ASC LIMIT 1;`,
      [value],
    );
    return row ? rowToItem(row) : undefined;
  }

  /**
   * The **active** items whose id begins with a printed short code — the fallback identifier
   * every label carries (`shortId` in `labels/label-template.ts`, issue #338).
   *
   * A short code is the first group of a UUID, so it names a record only by prefix: two items
   * *can* share one, and at that point picking a winner would be picking the wrong item as often
   * as the right one. So this returns the matches (capped at two — enough to know "one" from
   * "more than one") and leaves the caller to say so rather than guess. Ordered most-recent-first
   * for a deterministic result.
   *
   * A value that is not a short code — anything but eight hex characters — matches nothing
   * rather than being pattern-matched into the `LIKE`, so `%`/`_` in a scanned string can never
   * turn this into a wildcard scan.
   */
  async findByShortCode(code: string): Promise<Item[]> {
    const value = code.trim();
    if (!isShortItemCode(value)) return [];
    const rows = await this.driver.query<ItemRow>(
      `SELECT ${ITEM_READ_COLUMNS} FROM items
       WHERE items.id LIKE ? || '-%' AND is_active = 1
       ORDER BY created_at DESC, id ASC LIMIT 2;`,
      [value.toLowerCase()],
    );
    return rows.map(rowToItem);
  }

  /** A paginated, filtered list of items (spec §2.1), by `offset` or keyset `seek` (issue #172). */
  async list(filters: ItemListFilters = {}): Promise<Page<Item>> {
    const { limit, offset: offsetParam } = this.resolvePage(filters);
    // Stamp the clock at query time so the time-based status filters (expiring / overdue /
    // maintenance) evaluate against "now" when the read runs, keeping `now` out of the key.
    const [clause, filterParams] = buildListFilter({ ...filters, now: filters.now ?? nowMs() });
    // The favourites-first lead, the caller's sort (or the default), and the unique id tiebreak,
    // as one spec — the same spec builds the seek predicate below, so they can never diverge.
    const order = resolveItemOrder(filters.sort);
    const seek = filters.seek;

    // A backward (scroll-up) seek runs the reversed order and flips the rows back afterwards, so
    // it reuses the forward "strictly after" predicate. Everything else runs the forward order.
    const backward = seek?.direction === 'backward';
    const orderTerms = backward ? reverseOrder(order) : order;

    const where: string[] = [];
    const params: SqlValue[] = [...filterParams];
    if (clause) where.push(clause.replace(/^WHERE /, ''));
    if (seek) {
      const predicate = buildSeekPredicate(orderTerms, seek.cursor);
      where.push(predicate.sql);
      params.push(...predicate.params);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // The absolute index of the first row: the seek's running index, or the offset for an
    // offset read. Echoed into `Page.offset` so the virtualised list positions the page either way.
    const offset = seek ? seek.startIndex : offsetParam;
    params.push(limit);
    if (!seek) params.push(offset);

    const rows = await this.driver.query<ItemRow>(
      `SELECT ${ITEM_READ_COLUMNS} FROM items ${whereClause}
       ORDER BY ${renderOrderBy(orderTerms)}
       LIMIT ?${seek ? '' : ' OFFSET ?'};`,
      params,
    );
    // The reversed backward read came back last-to-first; flip it so the page is forward order.
    const ordered = backward ? rows.slice().reverse() : rows;

    const page = this.toPage(ordered.map(rowToItem), limit, offset);
    if (ordered.length === 0) return page;
    // Cursors are always taken from the forward-ordered rows, so `startCursor` is the first row and
    // `endCursor` the last regardless of which direction fetched the page.
    const startCursor: Cursor = extractCursor(ordered[0]!, order);
    const endCursor: Cursor = extractCursor(ordered[ordered.length - 1]!, order);
    return { ...page, startCursor, endCursor };
  }

  /** Count items matching a filter (for pagination headers / dashboard widgets). */
  async count(filters: Omit<ItemListFilters, 'limit' | 'offset'> = {}): Promise<number> {
    const [clause, params] = buildListFilter({ ...filters, now: filters.now ?? nowMs() });
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${clause};`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  async create(input: CreateItemInput): Promise<Item> {
    this.assertPermission('items:write');
    this.assertWritable();
    const resolved = resolveCreate(input);
    const id = crypto.randomUUID();
    const statements = buildInsert(id, resolved, null, this.actorId());
    // Apply the category-template default maintenance schedule (backlog T2a) in the same
    // transaction, so an item created in a category with a default schedule can never be
    // committed without it.
    statements.push(
      ...(await this.maintenanceDefaultInserts([{ itemId: id, categoryId: resolved.categoryId }])),
    );
    await this.driver.transaction(statements);
    return (await this.getById(id))!;
  }

  /**
   * Create many independent items in a **single** atomic transaction — the bulk-import
   * fast path. Every item's INSERT + ledger-seed + CREATED-log statements are gathered
   * and committed once, so a paste of N rows costs one OPFS commit (one fsync) instead
   * of N. This is the difference between an import of a few dozen rows feeling instant
   * versus taking many seconds (each standalone `create` pays a full commit). Because it
   * is one transaction it is all-or-nothing: an invalid row rolls the whole batch back,
   * which suits a pre-validated dry-run plan. Returns the created items in input order.
   */
  async createMany(inputs: readonly CreateItemInput[]): Promise<Item[]> {
    this.assertPermission('items:write');
    this.assertWritable();
    if (inputs.length === 0) return [];

    const ids: string[] = [];
    const pairs: { itemId: string; categoryId: string | null }[] = [];
    const statements: SqlStatement[] = [];
    for (const input of inputs) {
      const resolved = resolveCreate(input);
      const id = crypto.randomUUID();
      ids.push(id);
      pairs.push({ itemId: id, categoryId: resolved.categoryId });
      statements.push(...buildInsert(id, resolved, null, this.actorId()));
    }
    // Category-template default maintenance schedules (backlog T2a) for every row whose
    // category carries one — a single batched category read for the whole import, then one
    // INSERT per applicable item, all folded into the one all-or-nothing transaction.
    statements.push(...(await this.maintenanceDefaultInserts(pairs)));
    await this.driver.transaction(statements);

    const created = await Promise.all(ids.map((id) => this.getById(id)));
    return created.filter((i): i is Item => i !== undefined);
  }

  /**
   * Create N distinct SERIALISED instance records that share a name (spec §4
   * "Serialised" auto-clone). Each record gets quantity 1 and a serial number
   * 1..N, and logs its own CREATED entry, all in one atomic transaction. A `count`
   * of 1 (or omitted) yields a single instance #1. Write-gated.
   *
   * The count is **bounded** ({@link SERIALISED_COUNT_BOUNDS}, issue #677): this is the one
   * input that multiplies a single call into N irreversible records, so an out-of-range,
   * fractional or non-finite value is rejected here rather than clamped — quietly creating 500
   * records when 10,000 were asked for would be as surprising as creating 10,000, and an
   * `Infinity` (an overflowed `1e400` from a text box) would spin the loop below forever.
   */
  async createSerialised(input: CreateItemInput): Promise<Item[]> {
    this.assertPermission('items:write');
    this.assertWritable();
    const count = input.count ?? 1;
    if (!isValidSerialisedCount(count)) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Between ${SERIALISED_COUNT_BOUNDS.min} and ${SERIALISED_COUNT_BOUNDS.max} serialised records can be created at a time.`,
      );
    }
    const resolved = resolveCreate({ ...input, trackingMode: 'SERIALISED' });

    const ids: string[] = [];
    const statements: SqlStatement[] = [];
    for (let serial = 1; serial <= count; serial += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      statements.push(...buildInsert(id, resolved, serial, this.actorId()));
    }
    // Each serialised instance is its own asset, so each gets its own copy of the category's
    // default maintenance schedule (backlog T2a) — e.g. three drills, three calibration clocks.
    statements.push(
      ...(await this.maintenanceDefaultInserts(
        ids.map((itemId) => ({ itemId, categoryId: resolved.categoryId })),
      )),
    );
    await this.driver.transaction(statements);

    const created = await Promise.all(ids.map((id) => this.getById(id)));
    return created.filter((i): i is Item => i !== undefined);
  }

  /**
   * Build the category-template default maintenance-schedule INSERTs (backlog T2a) for a batch
   * of just-created items. One batched read of the distinct categories, then one schedule
   * INSERT per item whose category carries a *complete* default — the statements are returned
   * for the caller to fold into the item's own create transaction (atomic application).
   */
  private async maintenanceDefaultInserts(
    pairs: readonly { readonly itemId: string; readonly categoryId: string | null }[],
  ): Promise<SqlStatement[]> {
    const categoryIds = [...new Set(pairs.map((p) => p.categoryId).filter((id): id is string => !!id))];
    if (categoryIds.length === 0) return [];
    const placeholders = categoryIds.map(() => '?').join(', ');
    const rows = await this.driver.query<CategoryMaintenanceDefault & { id: string }>(
      `SELECT id, default_maintenance_basis, default_maintenance_interval_days,
              default_maintenance_interval_usage
       FROM categories WHERE id IN (${placeholders});`,
      categoryIds as SqlValue[],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: SqlStatement[] = [];
    for (const { itemId, categoryId } of pairs) {
      const stmt = buildCategoryMaintenanceInsert(itemId, categoryId ? byId.get(categoryId) : undefined);
      if (stmt) out.push(stmt);
    }
    return out;
  }

  async update(id: string, input: UpdateItemInput): Promise<Item> {
    this.assertPermission('items:write');
    this.assertWritable();
    const existing = await this.require(id);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const statements: SqlStatement[] = [];

    /**
     * The attributes whose edits raise a ledger row — the item's audit trail (issue #144),
     * and therefore also a webhook (`W10`).
     *
     * **Every structured attribute is tracked**: identity, classification, price, reordering,
     * perishability, provenance, lifecycle dates and physical measurements. What stays silent is
     * only free-form prose (`description`, `notes`, `operational_metadata`) — recording a
     * before/after copy of an arbitrarily long body of text on every edit would bloat a ledger
     * that syncs to every device, for a field nobody audits by value — and the deliberately
     * history-free reporting preferences (`is_favourite`, `is_unlimited`, `dead_stock_mode`).
     * `name`, `tracking_mode` and `condition` are tracked too, by their own dedicated actions.
     *
     * `label` is British-English prose for the note; `field` is the camelCase name a machine
     * consumer reads out of the metadata, alongside the `from`/`to` values that make the entry
     * an answer to "what was this before?" rather than just "something changed".
     *
     * A value set to what it already holds is **not** a change: `track` compares before
     * recording, so re-saving an unedited form writes no ledger row and fires no webhook.
     */
    const changedLabels: string[] = [];
    const changedFields: string[] = [];
    const changes: { field: string; from: SqlValue; to: SqlValue }[] = [];
    // `===` rather than `Object.is` deliberately: `Object.is(0, -0)` is false, and a numeric
    // field can pick up a negative zero from parsed input (`Number('-0')`), which would log a
    // change — and fire a webhook — every time an unchanged row was re-imported. No value
    // reaching here can be NaN (the normalisers reject non-finite input), so the other
    // difference between the two comparisons cannot arise.
    const track = (field: string, label: string, from: SqlValue, to: SqlValue): void => {
      if (from === to) return;
      changedFields.push(field);
      changedLabels.push(label);
      changes.push({ field, from, to });
    };
    /**
     * `track` for a money field. The two sides arrive on different scales — `existing` is the
     * mapped DTO (major units) while the normalised input is already stored micro-units (issue
     * #286) — so the *comparison* happens in micro-units (a no-op edit must match exactly) while
     * the *recorded* values are the major units every other consumer of the item speaks. That
     * mirrors `recordRevaluation`, whose metadata likewise carries the display value.
     */
    const trackMoney = (
      field: string,
      label: string,
      fromMajor: number | null,
      toStored: number | null,
    ): void => {
      if (toStoredMoney(fromMajor) === toStored) return;
      changedFields.push(field);
      changedLabels.push(label);
      changes.push({ field, from: fromMajor, to: fromStoredMoney(toStored) });
    };

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'An item must have a name.');
      }
      assertTextLimit(name, TEXT_LIMITS.line, 'An item name');
      if (name !== existing.name) {
        sets.push('name = ?');
        params.push(name);
        statements.push(
          historyStatement(id, 'RENAMED', this.actorId(), {
            note: `Renamed "${existing.name}" → "${name}".`,
            // The note has carried both names since Phase 2, but only as prose. The metadata
            // repeats them as fields so a machine consumer reads the rename the same way it
            // reads every other tracked edit (issue #144) rather than parsing the sentence.
            metadata: { from: existing.name, to: name },
          }),
        );
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
        historyStatement(id, 'TRACKING_CHANGED', this.actorId(), {
          note: `Tracking changed from "${existing.trackingMode}" to "${input.trackingMode}".`,
          metadata: { from: existing.trackingMode, to: input.trackingMode },
        }),
      );
    }
    if (input.description !== undefined) {
      if (input.description !== null) {
        assertTextLimit(input.description, TEXT_LIMITS.note, 'An item description');
      }
      sets.push('description = ?');
      params.push(input.description);
    }
    if (input.notes !== undefined) {
      if (input.notes !== null) assertTextLimit(input.notes, TEXT_LIMITS.note, 'Item notes');
      sets.push('notes = ?');
      params.push(input.notes);
    }
    if (input.categoryId !== undefined) {
      sets.push('category_id = ?');
      params.push(input.categoryId);
      track('categoryId', 'category', existing.categoryId, input.categoryId);
    }
    if (input.mpn !== undefined) {
      const mpn = normaliseText(input.mpn, TEXT_LIMITS.line, 'An MPN');
      sets.push('mpn = ?');
      params.push(mpn);
      track('mpn', 'MPN', existing.mpn, mpn);
    }
    if (input.manufacturer !== undefined) {
      const manufacturer = normaliseText(input.manufacturer, TEXT_LIMITS.line, 'A manufacturer');
      sets.push('manufacturer = ?');
      params.push(manufacturer);
      track('manufacturer', 'manufacturer', existing.manufacturer, manufacturer);
    }
    if (input.barcode !== undefined) {
      const barcode = normaliseText(input.barcode, TEXT_LIMITS.line, 'A barcode');
      sets.push('barcode = ?');
      params.push(barcode);
      track('barcode', 'barcode', existing.barcode, barcode);
    }
    if (input.serialNumber !== undefined) {
      const serialNumber = normaliseText(input.serialNumber, TEXT_LIMITS.line, 'A serial number');
      sets.push('serial_number = ?');
      params.push(serialNumber);
      track('serialNumber', 'serial number', existing.serialNumber, serialNumber);
    }
    if (input.unitCost !== undefined) {
      const unitCost = normaliseUnitCost(input.unitCost);
      sets.push('unit_cost = ?');
      params.push(unitCost);
      trackMoney('unitCost', 'unit cost', existing.unitCost, unitCost);
    }
    if (input.costPerUnitOfMeasure !== undefined) {
      // Gauge-only, mirroring the v1 CHECK with a legible message rather than letting a raw
      // SQLITE_CONSTRAINT surface: an item that counts units has no unit of measure to price,
      // and its `unit_cost` is already the right field (issue #683).
      if (existing.trackingMode !== 'CONSUMABLE_GAUGE') {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          'Cost per unit of measure applies only to CONSUMABLE_GAUGE items; use unit cost instead.',
        );
      }
      const costPerUnitOfMeasure = normaliseCostPerUnitOfMeasure(input.costPerUnitOfMeasure);
      sets.push('cost_per_unit_of_measure = ?');
      params.push(costPerUnitOfMeasure);
      trackMoney(
        'costPerUnitOfMeasure',
        'cost per unit of measure',
        existing.gauge?.costPerUnitOfMeasure ?? null,
        costPerUnitOfMeasure,
      );
    }
    if (input.expiryDate !== undefined) {
      const expiryDate = normaliseExpiry(input.expiryDate);
      sets.push('expiry_date = ?');
      params.push(expiryDate);
      track('expiryDate', 'expiry date', existing.expiryDate, expiryDate);
    }
    if (input.batchNumber !== undefined) {
      const batchNumber = normaliseText(input.batchNumber, TEXT_LIMITS.line, 'A batch number');
      sets.push('batch_number = ?');
      params.push(batchNumber);
      track('batchNumber', 'batch number', existing.batchNumber, batchNumber);
    }
    if (input.lotNumber !== undefined) {
      const lotNumber = normaliseText(input.lotNumber, TEXT_LIMITS.line, 'A lot number');
      sets.push('lot_number = ?');
      params.push(lotNumber);
      track('lotNumber', 'lot number', existing.lotNumber, lotNumber);
    }
    if (input.condition !== undefined && input.condition !== existing.condition) {
      sets.push('condition = ?');
      params.push(input.condition);
      statements.push(
        historyStatement(id, 'CONDITION_CHANGED', this.actorId(), {
          note: `Condition changed ${existing.condition ? `from "${existing.condition}" ` : ''}to "${input.condition ?? 'untracked'}".`,
          metadata: { from: existing.condition, to: input.condition },
        }),
      );
    }
    if (input.isUnlimited !== undefined) {
      // DISCRETE-only modifier (Phase 82) — mirror the DB CHECK with a clear message rather
      // than surfacing a raw constraint failure. Plain LWW column; never a HISTORY_ACTION.
      if (input.isUnlimited && existing.trackingMode !== 'DISCRETE') {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Only DISCRETE items can be marked as unlimited supply (${existing.name} is ${existing.trackingMode}).`,
        );
      }
      sets.push('is_unlimited = ?');
      params.push(input.isUnlimited ? 1 : 0);
    }
    if (input.isFavourite !== undefined) {
      // "Favourite" pin (issue #23): a personal curation that only reorders the list, not a
      // change to what the item is. Applies to any tracking mode, so no CHECK to mirror; a
      // plain LWW column with no HISTORY_ACTION (like is_unlimited).
      sets.push('is_favourite = ?');
      params.push(input.isFavourite ? 1 : 0);
    }
    if (input.deadStockMode !== undefined) {
      // Dead-stock reporting opt-in (issue #92): like the favourite pin, a reporting
      // preference rather than a change to what the item is, so it's a plain LWW column
      // with no HISTORY_ACTION. The DB CHECK mirrors DEAD_STOCK_MODES.
      sets.push('dead_stock_mode = ?');
      params.push(input.deadStockMode);
    }
    if (input.reorderPoint !== undefined) {
      const reorderPoint = normaliseReorderInt(input.reorderPoint);
      sets.push('reorder_point = ?');
      params.push(reorderPoint);
      track('reorderPoint', 'reorder point', existing.reorderPoint, reorderPoint);
    }
    if (input.reorderGaugePercent !== undefined) {
      const reorderGaugePercent = normaliseReorderPercent(input.reorderGaugePercent);
      sets.push('reorder_gauge_percent = ?');
      params.push(reorderGaugePercent);
      track(
        'reorderGaugePercent',
        'reorder gauge percentage',
        existing.reorderGaugePercent,
        reorderGaugePercent,
      );
    }
    if (input.reorderQty !== undefined) {
      const reorderQty = normaliseReorderInt(input.reorderQty);
      sets.push('reorder_qty = ?');
      params.push(reorderQty);
      track('reorderQty', 'reorder quantity', existing.reorderQty, reorderQty);
    }
    if (input.acquiredAt !== undefined) {
      const acquiredAt = normaliseIsoDate(input.acquiredAt);
      sets.push('acquired_at = ?');
      params.push(acquiredAt);
      track('acquiredAt', 'acquired date', existing.acquiredAt, acquiredAt);
    }
    if (input.warrantyExpiresAt !== undefined) {
      const warrantyExpiresAt = normaliseIsoDate(input.warrantyExpiresAt);
      sets.push('warranty_expires_at = ?');
      params.push(warrantyExpiresAt);
      track('warrantyExpiresAt', 'warranty expiry', existing.warrantyExpiresAt, warrantyExpiresAt);
    }
    if (input.purchasePrice !== undefined) {
      const purchasePrice = normalisePurchasePrice(input.purchasePrice);
      sets.push('purchase_price = ?');
      params.push(purchasePrice);
      trackMoney('purchasePrice', 'purchase price', existing.purchasePrice, purchasePrice);
    }
    if (input.depreciationMonths !== undefined) {
      const depreciationMonths = normaliseDepreciationMonths(input.depreciationMonths);
      sets.push('depreciation_months = ?');
      params.push(depreciationMonths);
      track('depreciationMonths', 'depreciation period', existing.depreciationMonths, depreciationMonths);
    }
    if (input.weight !== undefined) {
      const weight = normaliseWeight(input.weight);
      sets.push('weight = ?');
      params.push(weight);
      track('weight', 'weight', existing.weight, weight);
    }
    if (input.width !== undefined) {
      const width = normaliseDimension(input.width, 'Width');
      sets.push('width = ?');
      params.push(width);
      track('width', 'width', existing.width, width);
    }
    if (input.height !== undefined) {
      const height = normaliseDimension(input.height, 'Height');
      sets.push('height = ?');
      params.push(height);
      track('height', 'height', existing.height, height);
    }
    if (input.depth !== undefined) {
      const depth = normaliseDimension(input.depth, 'Depth');
      sets.push('depth = ?');
      params.push(depth);
      track('depth', 'depth', existing.depth, depth);
    }
    if (input.currentValue !== undefined) {
      // Manual current value (feature-gap G9). This path sets/clears the live column only —
      // a recorded revaluation (which also appends the log point) goes through
      // `recordRevaluation`. Kept here for clearing (null) and import/round-trip.
      const currentValue = normaliseCurrentValue(input.currentValue);
      sets.push('current_value = ?');
      params.push(currentValue);
      trackMoney('currentValue', 'current value', existing.currentValue, currentValue);
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

    if (changedFields.length > 0) {
      // One entry for the whole edit rather than one per field, so saving a form that touched
      // three attributes reads as a single change in the Activity Log and delivers a single
      // webhook. No `netValueDelta`, even for the price fields: that column carries realised
      // movement for the sales/margin report (`SOLD`), and a revaluation is not a movement —
      // populating it here would both distort that report and render a spurious delta badge.
      statements.push(
        historyStatement(id, 'ATTRIBUTES_CHANGED', this.actorId(), {
          note: `Changed ${changedLabels.join(', ')}.`,
          // `changes` is the audit record proper (issue #144) — each field's value before and
          // after, so "what was this item's cost in March, and who changed it?" is answerable
          // from the ledger alone rather than merely "something about the cost moved". `fields`
          // is the already-published field-name list (`W10`), kept beside it so an existing
          // consumer of this metadata keeps working; it is exactly `changes.map(c => c.field)`.
          metadata: { fields: changedFields, changes },
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

  /**
   * Move an item *wholesale* to another location, logging the move (spec §4 Activity
   * Log). Every per-location placement is consolidated into the target (Phase 25), so
   * an item split across drawers is brought back together; `location_id` (the item's
   * primary/home location) follows. Use `transferStock` to move *part* of an item's
   * stock to a second location while keeping the rest where it is.
   */
  async move(id: string, locationId: string): Promise<Item> {
    this.assertPermission('items:write');
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
      historyStatement(id, 'MOVED', this.actorId(), {
        note: 'Moved to a new location.',
        metadata: { fromLocationId: existing.locationId, toLocationId: locationId },
      }),
    ]);
    return (await this.getById(id))!;
  }

  /** Soft delete: mark inactive, preserving history (spec §4). Allowed when locked. */
  async softDelete(id: string, note?: string): Promise<Item> {
    this.assertPermission('items:delete');
    const existing = await this.require(id);
    if (!existing.isActive) return existing;
    await this.driver.transaction([
      { sql: 'UPDATE items SET is_active = 0 WHERE id = ?;', params: [id] },
      historyStatement(id, 'SOFT_DELETED', this.actorId(), {
        note: note ?? 'Marked as removed from active inventory.',
      }),
    ]);
    return (await this.getById(id))!;
  }

  async restore(id: string): Promise<Item> {
    this.assertPermission('items:write');
    this.assertWritable();
    const existing = await this.require(id);
    if (existing.isActive) return existing;
    await this.driver.transaction([
      { sql: 'UPDATE items SET is_active = 1 WHERE id = ?;', params: [id] },
      historyStatement(id, 'RESTORED', this.actorId(), { note: 'Restored to active inventory.' }),
    ]);
    return (await this.getById(id))!;
  }

  /**
   * Hard delete: permanently purge the item (spec §4). Cascades the Activity Log.
   * Allowed under the storage Hard Stop. Records a tombstone in the *same*
   * transaction so the deletion propagates on the next sync (§7.2).
   */
  async hardDelete(id: string): Promise<void> {
    this.assertPermission('items:delete');
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

  /**
   * Clear one item's Activity Log (issue #620), leaving a single `HISTORY_CLEARED` entry
   * that records who cleared it and how many entries went. The ledger is append-only, and
   * this is the only operation that removes **one item's** entries — the §7.6.3-A retention
   * prune ({@link StorageRepository.pruneHistoryBefore}) and the Danger-Zone "activity
   * history" erase both cut across the whole table. See {@link clearHistoryStatements} for
   * why the marker is written before the delete.
   *
   * Gated on `audit:delete`, the same permission the storage-triage history prune uses:
   * both destroy an audit trail, which is a strictly bigger deal than editing the item it
   * belongs to. Deliberately **not** gated on the storage Hard Stop, for the same reason
   * that prune is not — the operation reclaims space, and refusing it would trap the very
   * user a locked device leaves stuck.
   *
   * `clearedBy` is the display label recorded in the entry's note: the signed-in user when
   * the users module is on, otherwise a marker for the device that asked. The authoritative
   * attribution is the entry's `actor_user_id`, written from the current actor as usual.
   */
  async clearHistory(id: string, clearedBy: string): Promise<void> {
    this.assertPermission('audit:delete');
    await this.driver.transaction(clearHistoryStatements(id, this.actorId(), clearedBy));
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
  if (filters.tagIds && filters.tagIds.length > 0) {
    // Tag facet: keep items carrying any of the selected tags (OR within the facet). A
    // subquery over the `item_tags` edge keeps the row test set-based and index-friendly.
    where.push(
      `items.id IN (SELECT item_id FROM item_tags WHERE tag_id IN (${filters.tagIds.map(() => '?').join(', ')}))`,
    );
    params.push(...filters.tagIds);
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
  if (filters.status && filters.status.length > 0) {
    // Derived-status "attention" filters (low stock / expiring / overdue / maintenance due):
    // an OR-combined group AND-ed alongside the other filters. `now` is stamped by the
    // caller (`list`/`count`); the predicate SQL is each concept's SSOT (see status-filter.ts).
    const [statusClause, statusParams] = buildStatusFilter(filters.status, {
      now: filters.now ?? nowMs(),
      lowStockThresholds: filters.lowStockThresholds,
      expirySoonWindowDays: filters.expirySoonWindowDays,
    });
    if (statusClause) {
      where.push(statusClause);
      params.push(...statusParams);
    }
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return [clause, params];
}
