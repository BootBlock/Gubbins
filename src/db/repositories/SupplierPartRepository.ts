/**
 * SupplierPartRepository (spec §2.1.1, §4 supplier facet; Inventory-depth Phase 60).
 *
 * Owns the N-suppliers-per-item model: each row is one supplier's offer for an item
 * (order code, optional unit cost / currency / pack / MOQ, quantity price-breaks, URL),
 * with at most one marked **preferred**. {@link setPreferred} enforces the single-winner
 * invariant in one transaction so two suppliers can never both be preferred for an item.
 *
 * All SQL lives over the injected driver (§2.1.1) — components never write SQL. Creation
 * grows storage and is therefore Hard-Stop gated; deletes (which free space) are not and
 * record a tombstone in the same transaction so the deletion syncs (§7.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToSupplierPart, rowToSupplierPartPriceHistory } from './mappers';
import { tombstoneStatement } from './tombstone';
import type { SqlStatement, SqlValue } from '../rpc/driver';
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

/** Validate a nullable non-negative cost (the CHECK also enforces ≥ 0). */
function cleanCost(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'A unit cost must be a non-negative number.');
  }
  return value;
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
  async getById(id: string): Promise<SupplierPart | undefined> {
    const row = await this.driver.queryOne<SupplierPartRow>('SELECT * FROM supplier_parts WHERE id = ?;', [
      id,
    ]);
    return row ? rowToSupplierPart(row) : undefined;
  }

  /** Every supplier part for an item, preferred first then by supplier name. */
  async listForItem(itemId: string): Promise<SupplierPart[]> {
    const rows = await this.driver.query<SupplierPartRow>(
      `SELECT * FROM supplier_parts WHERE item_id = ?
       ORDER BY is_preferred DESC, supplier_name COLLATE NOCASE ASC, order_code COLLATE NOCASE ASC;`,
      [itemId],
    );
    return rows.map(rowToSupplierPart);
  }

  /** The preferred supplier part for an item, if one is marked. */
  async getPreferred(itemId: string): Promise<SupplierPart | undefined> {
    const row = await this.driver.queryOne<SupplierPartRow>(
      'SELECT * FROM supplier_parts WHERE item_id = ? AND is_preferred = 1 LIMIT 1;',
      [itemId],
    );
    return row ? rowToSupplierPart(row) : undefined;
  }

  async create(itemId: string, input: CreateSupplierPartInput): Promise<SupplierPart> {
    this.assertWritable();
    const supplierName = cleanText(input.supplierName);
    if (!supplierName) {
      throw new DbError('SQLITE_CONSTRAINT', 'A supplier part must have a supplier name.');
    }
    const id = crypto.randomUUID();
    const wantsPreferred = input.isPreferred === true;
    const cost = cleanCost(input.unitCost);
    const currency = cleanText(input.currency);

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
              (id, item_id, supplier_name, order_code, unit_cost, currency, pack_qty,
               min_order_qty, price_breaks, url, is_preferred)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        itemId,
        supplierName,
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
    this.assertWritable();
    const existing = await this.require(id);

    // Phase 81: record a price-history point only when the cost is a *genuine* non-null
    // change — a no-op write (same value) or a clear-to-null records nothing, so the series
    // never carries a noise point. The currency tracked is the new one when supplied, else
    // the existing one (the cost applies in whatever currency the row now carries).
    let priceHistory: SqlStatement | null = null;
    if (input.unitCost !== undefined) {
      const newCost = cleanCost(input.unitCost);
      if (newCost !== null && newCost !== existing.unitCost) {
        const currency = input.currency !== undefined ? cleanText(input.currency) : existing.currency;
        priceHistory = priceHistoryStatement(id, newCost, currency, input.source ?? 'MANUAL');
      }
    }

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.supplierName !== undefined) {
      const name = cleanText(input.supplierName);
      if (!name) {
        throw new DbError('SQLITE_CONSTRAINT', 'A supplier part must have a supplier name.');
      }
      sets.push('supplier_name = ?');
      params.push(name);
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

  /** Delete a supplier part. Bypasses the Hard Stop; tombstoned for sync (§7.2). */
  async delete(id: string): Promise<void> {
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
