/**
 * SupplierPartRepository (spec §2.1.1, §4 supplier facet; Inventory-depth Phase 60).
 *
 * Owns the N-suppliers-per-item model: each row is one supplier's offer for an item
 * (order code, optional unit cost / currency / pack / MOQ, quantity price-breaks, URL),
 * with at most one marked **preferred**. {@link setPreferred} enforces the single-winner
 * invariant in one transaction so two suppliers can never both be preferred for an item.
 *
 * The supplier itself is a first-class row (issue #384): a part carries `supplier_id`, and
 * every read joins `suppliers` to project the canonical name alongside it, so a consumer still
 * reads `supplierName` without knowing the join exists. Writes name their supplier through a
 * {@link SupplierRef} and resolve it via {@link SupplierRepository.resolveRef} — the single
 * seam through which a name may enter the database.
 *
 * All SQL lives over the injected driver (§2.1.1) — components never write SQL. Creation
 * grows storage and is therefore Hard-Stop gated; deletes (which free space) are not and
 * record a tombstone in the same transaction so the deletion syncs (§7.2).
 */
import { toStoredMoney } from '@/lib/money';
import { DbError } from '../errors';
import { BaseRepository, collaboratorOptions, type RepositoryOptions } from './base';
import { rowToSupplierPart, rowToSupplierPartPriceHistory } from './mappers';
import { SupplierRepository } from './SupplierRepository';
import { tombstoneStatement } from './tombstone';
import type { IDatabaseDriver, SqlStatement, SqlValue } from '../rpc/driver';
import type {
  CreateSupplierPartInput,
  PageParams,
  PriceBreak,
  PriceHistorySource,
  SupplierPart,
  SupplierPartPriceHistoryEntry,
  SupplierPartPriceHistoryRow,
  SupplierPartRow,
  UpdateSupplierPartInput,
} from './types';

/**
 * Every supplier-part read goes through this projection: the part's own columns plus the
 * canonical `suppliers.name` as `supplier_name`, which is what {@link rowToSupplierPart}
 * surfaces as the DTO's read-only `supplierName`. Defined once so no read can forget the join
 * and hand back a row with no supplier on it.
 */
const SUPPLIER_PART_SELECT = `SELECT sp.*, s.name AS supplier_name
                                FROM supplier_parts sp
                                JOIN suppliers s ON s.id = sp.supplier_id`;

/**
 * Build the price-history INSERT recording a supplier part's cost at this instant, to be
 * batched in the *same* transaction as the create/update that set it (Phase 81). Only
 * called when the cost is a genuine non-null change, so the series never carries a no-op or
 * a cleared-to-null point.
 */
function priceHistoryStatement(
  supplierPartId: string,
  unitCost: number,
  currency: string | null,
  source: PriceHistorySource,
): SqlStatement {
  return {
    sql: `INSERT INTO supplier_part_price_history (id, supplier_part_id, unit_cost, currency, source)
          VALUES (?, ?, ?, ?, ?);`,
    params: [crypto.randomUUID(), supplierPartId, unitCost, currency, source],
  };
}

/** Trim a string field; an all-whitespace value becomes null (a genuinely absent field). */
function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate a nullable non-negative cost (the CHECK also enforces ≥ 0) and return it in integer
 * micro-units — the on-disk money scale (issue #286) — so `supplier_parts.unit_cost` and the
 * `supplier_part_price_history` point it seeds share one representation.
 */
function cleanCost(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'A unit cost must be a non-negative number.');
  }
  return toStoredMoney(value);
}

/** Validate a nullable positive integer count (pack size / MOQ). */
function cleanCount(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new DbError('SQLITE_CONSTRAINT', `${label} must be a positive whole number.`);
  }
  return value;
}

/**
 * Validate and serialise quantity price-breaks to the JSON column. Each entry needs a
 * positive `qty` and a non-negative `unitCost`; the array is stored ascending by qty.
 * An empty/absent list is stored as NULL.
 */
function serialisePriceBreaks(breaks: readonly PriceBreak[] | null | undefined): string | null {
  if (breaks === null || breaks === undefined || breaks.length === 0) return null;
  const clean: PriceBreak[] = [];
  for (const b of breaks) {
    if (!Number.isFinite(b.qty) || b.qty <= 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A price-break quantity must be a positive number.');
    }
    if (!Number.isFinite(b.unitCost) || b.unitCost < 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A price-break unit cost must be a non-negative number.');
    }
    clean.push({ qty: b.qty, unitCost: b.unitCost });
  }
  clean.sort((a, b) => a.qty - b.qty);
  return JSON.stringify(clean);
}

export class SupplierPartRepository extends BaseRepository {
  private readonly suppliers: SupplierRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.suppliers = new SupplierRepository(driver, collaboratorOptions(options));
  }

  async getById(id: string): Promise<SupplierPart | undefined> {
    const row = await this.driver.queryOne<SupplierPartRow>(`${SUPPLIER_PART_SELECT} WHERE sp.id = ?;`, [id]);
    return row ? rowToSupplierPart(row) : undefined;
  }

  /** Every supplier part for an item, preferred first then by supplier name. */
  async listForItem(itemId: string): Promise<SupplierPart[]> {
    const rows = await this.driver.query<SupplierPartRow>(
      `${SUPPLIER_PART_SELECT} WHERE sp.item_id = ?
       ORDER BY sp.is_preferred DESC, s.name COLLATE NOCASE ASC, sp.order_code COLLATE NOCASE ASC;`,
      [itemId],
    );
    return rows.map(rowToSupplierPart);
  }

  /**
   * Every supplier part for a set of items, in one round-trip — the batch companion to
   * {@link listForItem} used by the Purchase-Order line editor so it can apply each item's
   * quantity price-breaks without an N+1 fan-out (issue #37). Resolves to a `Map` keyed by
   * item id (an item with no supplier parts is simply absent); an empty input queries nothing.
   * Within each item's list the ordering matches {@link listForItem} (preferred first).
   */
  async listForItems(itemIds: readonly string[]): Promise<Map<string, SupplierPart[]>> {
    const byItem = new Map<string, SupplierPart[]>();
    if (itemIds.length === 0) return byItem;
    const placeholders = itemIds.map(() => '?').join(', ');
    const rows = await this.driver.query<SupplierPartRow>(
      `${SUPPLIER_PART_SELECT} WHERE sp.item_id IN (${placeholders})
       ORDER BY sp.is_preferred DESC, s.name COLLATE NOCASE ASC, sp.order_code COLLATE NOCASE ASC;`,
      [...itemIds],
    );
    for (const row of rows) {
      const part = rowToSupplierPart(row);
      const list = byItem.get(part.itemId);
      if (list) list.push(part);
      else byItem.set(part.itemId, [part]);
    }
    return byItem;
  }

  /** The preferred supplier part for an item, if one is marked. */
  async getPreferred(itemId: string): Promise<SupplierPart | undefined> {
    const row = await this.driver.queryOne<SupplierPartRow>(
      `${SUPPLIER_PART_SELECT} WHERE sp.item_id = ? AND sp.is_preferred = 1 LIMIT 1;`,
      [itemId],
    );
    return row ? rowToSupplierPart(row) : undefined;
  }

  async create(itemId: string, input: CreateSupplierPartInput): Promise<SupplierPart> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    const wantsPreferred = input.isPreferred === true;
    // Validate BEFORE resolving the supplier: resolving can mint a new supplier row, and it is
    // not part of the transaction below, so doing it first would leave a phantom supplier in
    // the dictionary every time a write was rejected for an unrelated bad field.
    const cost = cleanCost(input.unitCost);
    const currency = cleanText(input.currency);
    // A typed name folds onto the existing supplier (or mints one); an id is verified. Either
    // way the part stores only the id — the name is the supplier's, not the part's.
    const supplierId = await this.suppliers.resolveRef(input.supplier);
    const id = crypto.randomUUID();

    const statements: SqlStatement[] = [];
    // Single-winner: clear any existing preferred for this item before marking the new one.
    if (wantsPreferred) {
      // A bare SET leaves updated_at unchanged, so the §7.1 auto-stamp trigger re-stamps it
      // — the de-selection then propagates by LWW.
      statements.push({
        sql: 'UPDATE supplier_parts SET is_preferred = 0 WHERE item_id = ? AND is_preferred = 1;',
        params: [itemId],
      });
    }
    statements.push({
      sql: `INSERT INTO supplier_parts
              (id, item_id, supplier_id, order_code, unit_cost, currency, pack_qty,
               min_order_qty, price_breaks, url, is_preferred)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        itemId,
        supplierId,
        cleanText(input.orderCode),
        cost,
        currency,
        cleanCount(input.packQty, 'A pack quantity'),
        cleanCount(input.minOrderQty, 'A minimum order quantity'),
        serialisePriceBreaks(input.priceBreaks),
        cleanText(input.url),
        wantsPreferred ? 1 : 0,
      ],
    });

    // Phase 81: record the baseline price point when the part is created with a cost.
    if (cost !== null) {
      statements.push(priceHistoryStatement(id, cost, currency, input.source ?? 'MANUAL'));
    }

    await this.driver.transaction(statements);
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateSupplierPartInput): Promise<SupplierPart> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    const existing = await this.require(id);

    // Phase 81: record a price-history point only when the cost is a *genuine* non-null
    // change — a no-op write (same value) or a clear-to-null records nothing, so the series
    // never carries a noise point. The currency tracked is the new one when supplied, else
    // the existing one (the cost applies in whatever currency the row now carries).
    let priceHistory: SqlStatement | null = null;
    if (input.unitCost !== undefined) {
      const newCost = cleanCost(input.unitCost);
      // Both sides compared in stored micro-units: `existing.unitCost` is the mapped DTO (major
      // units), so it is scaled up to match `newCost` — and integer comparison sidesteps the
      // float-equality noise a "did the cost change?" test would otherwise carry.
      if (newCost !== null && newCost !== toStoredMoney(existing.unitCost)) {
        const currency = input.currency !== undefined ? cleanText(input.currency) : existing.currency;
        priceHistory = priceHistoryStatement(id, newCost, currency, input.source ?? 'MANUAL');
      }
    }

    const sets: string[] = [];
    const params: SqlValue[] = [];
    // Re-pointing the part at another supplier moves the id; it never edits a name in place —
    // renaming is the supplier's own operation and applies everywhere at once.
    if (input.supplier !== undefined) {
      sets.push('supplier_id = ?');
      params.push(await this.suppliers.resolveRef(input.supplier));
    }
    if (input.orderCode !== undefined) {
      sets.push('order_code = ?');
      params.push(cleanText(input.orderCode));
    }
    if (input.unitCost !== undefined) {
      sets.push('unit_cost = ?');
      params.push(cleanCost(input.unitCost));
    }
    if (input.currency !== undefined) {
      sets.push('currency = ?');
      params.push(cleanText(input.currency));
    }
    if (input.packQty !== undefined) {
      sets.push('pack_qty = ?');
      params.push(cleanCount(input.packQty, 'A pack quantity'));
    }
    if (input.minOrderQty !== undefined) {
      sets.push('min_order_qty = ?');
      params.push(cleanCount(input.minOrderQty, 'A minimum order quantity'));
    }
    if (input.priceBreaks !== undefined) {
      sets.push('price_breaks = ?');
      params.push(serialisePriceBreaks(input.priceBreaks));
    }
    if (input.url !== undefined) {
      sets.push('url = ?');
      params.push(cleanText(input.url));
    }

    // A preferred toggle goes through the single-winner transaction, never a bare SET.
    if (input.isPreferred === true && !existing.isPreferred) {
      const statements: SqlStatement[] = [
        {
          sql: 'UPDATE supplier_parts SET is_preferred = 0 WHERE item_id = ? AND is_preferred = 1;',
          params: [existing.itemId],
        },
      ];
      sets.push('is_preferred = 1');
      params.push(id);
      statements.push({ sql: `UPDATE supplier_parts SET ${sets.join(', ')} WHERE id = ?;`, params });
      if (priceHistory) statements.push(priceHistory);
      await this.driver.transaction(statements);
      return (await this.getById(id))!;
    }
    if (input.isPreferred === false) {
      sets.push('is_preferred = 0');
    }

    if (sets.length > 0) {
      params.push(id);
      const updateStmt: SqlStatement = {
        sql: `UPDATE supplier_parts SET ${sets.join(', ')} WHERE id = ?;`,
        params,
      };
      // Fold the price-history point into the *same* transaction as the cost write so the
      // ledger can never drift from the supplier part.
      if (priceHistory) {
        await this.driver.transaction([updateStmt, priceHistory]);
      } else {
        await this.driver.execute(updateStmt.sql, updateStmt.params);
      }
    }
    return (await this.getById(id))!;
  }

  /**
   * A supplier part's recorded price points, newest first (Phase 81). Tiny per part, but
   * strictly bounded per the §2.1 pagination mandate. The pure `buildPriceSeries` seam
   * sorts ascending for the sparkline regardless of this order.
   */
  async listPriceHistory(
    supplierPartId: string,
    params: PageParams = {},
  ): Promise<SupplierPartPriceHistoryEntry[]> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<SupplierPartPriceHistoryRow>(
      `SELECT * FROM supplier_part_price_history WHERE supplier_part_id = ?
       ORDER BY recorded_at DESC, rowid DESC
       LIMIT ? OFFSET ?;`,
      [supplierPartId, limit, offset],
    );
    return rows.map(rowToSupplierPartPriceHistory);
  }

  /**
   * Mark one supplier part as the item's single preferred winner: set it and clear every
   * other preferred row for the same item, in one atomic transaction. Re-stamping the
   * cleared rows lets their LWW updated_at advance so the de-selection propagates on sync.
   */
  async setPreferred(id: string): Promise<void> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    const part = await this.require(id);
    // Bare SETs leave updated_at unchanged so the §7.1 auto-stamp trigger re-stamps every
    // touched row — both the new winner and any de-selected sibling propagate by LWW.
    await this.driver.transaction([
      {
        sql: 'UPDATE supplier_parts SET is_preferred = 0 WHERE item_id = ? AND id <> ? AND is_preferred = 1;',
        params: [part.itemId, id],
      },
      { sql: 'UPDATE supplier_parts SET is_preferred = 1 WHERE id = ?;', params: [id] },
    ]);
  }

  /**
   * Pin one supplier part as the item's single **price source** (issue #28): set it and clear
   * every other price-source row for the same item, in one atomic transaction. Mirrors
   * {@link setPreferred} but on the independent `is_price_source` flag — a price refresh fetches
   * only this supplier while it is pinned. Re-stamping the cleared rows lets their LWW updated_at
   * advance so the de-selection propagates on sync.
   */
  async setPriceSource(id: string): Promise<void> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    const part = await this.require(id);
    await this.driver.transaction([
      {
        sql: 'UPDATE supplier_parts SET is_price_source = 0 WHERE item_id = ? AND id <> ? AND is_price_source = 1;',
        params: [part.itemId, id],
      },
      { sql: 'UPDATE supplier_parts SET is_price_source = 1 WHERE id = ?;', params: [id] },
    ]);
  }

  /**
   * Clear the item's pinned price source (issue #28), so a refresh again fetches every supplier
   * and reports the cheapest. Clears whichever row (if any) is currently pinned for the item.
   */
  async clearPriceSource(itemId: string): Promise<void> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    await this.driver.execute(
      'UPDATE supplier_parts SET is_price_source = 0 WHERE item_id = ? AND is_price_source = 1;',
      [itemId],
    );
  }

  /** Delete a supplier part. Bypasses the Hard Stop; tombstoned for sync (§7.2). */
  async delete(id: string): Promise<void> {
    // A supplier part is a child record of a supplier, not a supplier — removing one edits the
    // supplier's catalogue rather than deleting the entity, so this is `write` (the same rule
    // that puts `AttachmentRepository.remove` under `items:write`).
    this.assertPermission('suppliers:write');
    await this.driver.transaction([
      { sql: 'DELETE FROM supplier_parts WHERE id = ?;', params: [id] },
      tombstoneStatement('supplier_parts', id),
    ]);
  }

  private async require(id: string): Promise<SupplierPart> {
    const part = await this.getById(id);
    if (!part) {
      throw new DbError('SQLITE_CONSTRAINT', `Supplier part "${id}" does not exist.`);
    }
    return part;
  }
}
