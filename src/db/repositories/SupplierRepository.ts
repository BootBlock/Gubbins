/**
 * SupplierRepository (issue #384).
 *
 * The canonical supplier dictionary. Before this existed, a supplier was a free-text name
 * re-typed on every supplier part and purchase order, so the same supplier spelled two ways
 * was two unrelated strings — nothing could rename it, and nothing could reconcile the
 * variants. Both `supplier_parts` and `purchase_orders` now reference a row here by id.
 *
 * Two properties do the real work:
 *
 * - **Resolve-or-create** ({@link resolveOrCreate}) keeps entry low-friction in the same way
 *   `ContactRepository` does — a typed name still just works — while quietly folding it onto
 *   the existing supplier instead of minting a near-duplicate.
 * - **Merge** ({@link merge}) is the repair path for duplicates that already exist, and the way
 *   to retire a supplier while its purchase-order history keeps naming one. A plain
 *   {@link delete} is also allowed: the orders are ON DELETE SET NULL, so history is never
 *   dropped by tidying up a list — it just stops naming a supplier.
 */
import { normaliseSupplierName, supplierNameKey } from '../../lib/supplier-name';
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToSupplier } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  CreateSupplierInput,
  Page,
  PageParams,
  Supplier,
  SupplierRef,
  SupplierRow,
  SupplierWithCounts,
  UpdateSupplierInput,
} from './types';

interface SupplierCountRow extends SupplierRow {
  readonly part_count: number;
  readonly order_count: number;
}

export class SupplierRepository extends BaseRepository {
  async getById(id: string): Promise<Supplier | undefined> {
    const row = await this.driver.queryOne<SupplierRow>('SELECT * FROM suppliers WHERE id = ?;', [id]);
    return row ? rowToSupplier(row) : undefined;
  }

  /**
   * Paginated suppliers by name, each with the counts a delete needs to warn about: how many
   * supplier parts would go with it, and how many purchase orders would stop naming a supplier.
   */
  async list(params: PageParams = {}): Promise<Page<SupplierWithCounts>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<SupplierCountRow>(
      `SELECT s.*,
              (SELECT COUNT(*) FROM supplier_parts sp WHERE sp.supplier_id = s.id) AS part_count,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS order_count
       FROM suppliers s
       ORDER BY s.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({
        ...rowToSupplier(r),
        partCount: Number(r.part_count),
        orderCount: Number(r.order_count),
      })),
      limit,
      offset,
    );
  }

  /**
   * Look a supplier up by name under the folded identity key, so `RS Components`,
   * `rs  components` and `RS-Components` all find the same row.
   */
  async findByName(name: string): Promise<Supplier | undefined> {
    const key = supplierNameKey(name);
    if (key.length === 0) return undefined;
    const row = await this.driver.queryOne<SupplierRow>('SELECT * FROM suppliers WHERE name_key = ?;', [key]);
    return row ? rowToSupplier(row) : undefined;
  }

  async create(input: CreateSupplierInput): Promise<Supplier> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    const name = normaliseSupplierName(input.name);
    const key = supplierNameKey(name);
    if (key.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A supplier must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO suppliers (id, name, name_key, url, currency, note)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, name, key, input.url?.trim() || null, input.currency?.trim() || null, input.note?.trim() || null],
    );
    return (await this.getById(id))!;
  }

  /**
   * Low-friction lookup-or-create: returns the supplier this name folds onto, or mints one.
   * The race between the lookup and the insert is closed by the UNIQUE index on `name_key` —
   * a concurrent create surfaces as a constraint error, which we resolve by re-reading.
   */
  async resolveOrCreate(name: string): Promise<Supplier> {
    this.assertPermission('suppliers:write');
    const existing = await this.findByName(name);
    if (existing) return existing;
    try {
      return await this.create({ name });
    } catch (error) {
      const fallback = await this.findByName(name);
      if (fallback) return fallback;
      throw error;
    }
  }

  /**
   * Resolve a {@link SupplierRef} to a supplier id — the single seam every write that names a
   * supplier goes through, so no caller can put an unreconciled name into the database.
   */
  async resolveRef(ref: SupplierRef): Promise<string> {
    this.assertPermission('suppliers:write');
    if ('supplierId' in ref) {
      await this.require(ref.supplierId);
      return ref.supplierId;
    }
    return (await this.resolveOrCreate(ref.supplierName)).id;
  }

  async update(id: string, input: UpdateSupplierInput): Promise<Supplier> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    await this.require(id);
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (input.name !== undefined) {
      const name = normaliseSupplierName(input.name);
      const key = supplierNameKey(name);
      if (key.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A supplier must have a name.');
      }
      // A rename that collides with another supplier is a merge, not an update — the caller
      // has to say so explicitly, because merging is destructive of one of the two rows.
      const clash = await this.driver.queryOne<{ id: string }>(
        'SELECT id FROM suppliers WHERE name_key = ? AND id <> ?;',
        [key, id],
      );
      if (clash) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `A different supplier is already named "${name}". Merge them instead.`,
        );
      }
      sets.push('name = ?', 'name_key = ?');
      params.push(name, key);
    }
    if (input.url !== undefined) {
      sets.push('url = ?');
      params.push(input.url?.trim() || null);
    }
    if (input.currency !== undefined) {
      sets.push('currency = ?');
      params.push(input.currency?.trim() || null);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(input.note?.trim() || null);
    }
    if (sets.length > 0) {
      await this.driver.execute(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Fold `sourceId` into `targetId`: every supplier part and purchase order is re-pointed at
   * the target and the source row is deleted, all in one transaction so a partial failure
   * cannot leave rows pointing at a supplier that no longer exists.
   *
   * This is the repair path for duplicates. It differs from {@link delete} in what happens to
   * the history: merging *keeps* the source's orders and parts by moving them onto the target,
   * where deleting drops the parts and leaves the orders naming no supplier at all.
   */
  async merge(sourceId: string, targetId: string): Promise<Supplier> {
    this.assertPermission('suppliers:write');
    this.assertWritable();
    if (sourceId === targetId) {
      throw new DbError('SQLITE_CONSTRAINT', 'Cannot merge a supplier into itself.');
    }
    await this.require(sourceId);
    await this.require(targetId);
    await this.driver.transaction([
      {
        sql: 'UPDATE supplier_parts SET supplier_id = ? WHERE supplier_id = ?;',
        params: [targetId, sourceId],
      },
      {
        sql: 'UPDATE purchase_orders SET supplier_id = ? WHERE supplier_id = ?;',
        params: [targetId, sourceId],
      },
      { sql: 'DELETE FROM suppliers WHERE id = ?;', params: [sourceId] },
      tombstoneStatement('suppliers', sourceId),
    ]);
    return (await this.getById(targetId))!;
  }

  /**
   * Delete a supplier. Its supplier parts cascade away with it, but its purchase orders are
   * kept with their supplier link cleared (ON DELETE SET NULL) — an order records money spent
   * and outlives the supplier it was placed with. Callers should warn on both counts (see
   * {@link SupplierWithCounts}) and offer {@link merge} when the intent is to reconcile a
   * duplicate rather than discard the supplier. Records a tombstone so the deletion syncs (§7.2).
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('suppliers:delete');
    await this.driver.transaction([
      { sql: 'DELETE FROM suppliers WHERE id = ?;', params: [id] },
      tombstoneStatement('suppliers', id),
    ]);
  }

  private async require(id: string): Promise<Supplier> {
    const supplier = await this.getById(id);
    if (!supplier) {
      throw new DbError('SQLITE_CONSTRAINT', `Supplier "${id}" does not exist.`);
    }
    return supplier;
  }
}
