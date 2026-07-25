/**
 * PurchaseOrderRepository (spec §4 procurement; Inventory-depth Phase 62).
 *
 * Owns the supplier-keyed Purchase Order document and its lines. A line receives into the
 * **existing** per-location / per-batch stock machinery (Phase 25 / Phase 28) via the shared
 * receipt seam — {@link receiveLine} mirrors `ProjectRepository.receiveLine` and reuses the
 * same statement builders (`planPoReceipt` → `planReceipt`, `addStockStatement` /
 * `addBatchStatement`, `historyStatement`), so there is never a second stock-mutation path.
 *
 * The PO `status` is **derived, not stored** for an active order: DRAFT and CANCELLED are the
 * only user-set authoritative states; ORDERED / PARTIAL / RECEIVED are recomputed from the
 * lines' receipt totals via {@link derivePoStatus}. The repository persists a snapshot of the
 * derived value (so a peer on a stale schema still reads a sensible status) but every read
 * recomputes it, and {@link onOrderQtyForItem} is a derived projection like the Phase-20
 * In-Transit one — never a stored counter.
 *
 * The supplier is a first-class row (issue #384): the header carries `supplier_id`, and every
 * read joins `suppliers` to project the canonical name, so a consumer still reads
 * `supplierName` without knowing the join exists. Writes name their supplier through a
 * {@link SupplierRef} resolved by {@link SupplierRepository.resolveRef}. The reference is
 * nullable, ON DELETE SET NULL — tidying a supplier list can never drop spend history; the
 * order survives and simply reads as an unknown supplier.
 *
 * All SQL lives over the injected driver (§2.1.1). Creation grows storage and is Hard-Stop
 * gated; deletes (which free space) are not and record a tombstone in the same transaction so
 * the deletion syncs (§7.2).
 */
import { toStoredMoney } from '@/lib/money';
import { batchKeyOf, type BatchIdentity } from '@/features/inventory/batches';
import { SQL_NOW_MS } from '../migrations/migration';
import { planPoReceipt, planPoReturn } from '@/features/purchasing/po-receipt';
import { derivePoStatus, type PoStatusLine } from '@/features/purchasing/po-status';
import { type ReorderPlanGroup } from '@/features/purchasing/reorder-plan';
import { DbError } from '../errors';
import { BaseRepository, collaboratorOptions, type RepositoryOptions } from './base';
import { historyStatement } from './item/history';
import { rowToPurchaseOrder, rowToPurchaseOrderLine } from './mappers';
import { addStockStatement, stockRowId } from './stock';
import { addBatchStatement, placementDeltaStatements, runStockDraw } from './stock-batches';
import { SupplierRepository } from './SupplierRepository';
import { tombstoneStatement } from './tombstone';
import type { IDatabaseDriver, SqlStatement, SqlValue } from '../rpc/driver';
import type { Page, PageParams } from './types';
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrderLineInput,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  PurchaseOrderWithLines,
  UpdatePurchaseOrderInput,
  UpdatePurchaseOrderLineInput,
} from './types';

/**
 * The single definition of an "on order" line: an outstanding (partly- or un-received) line
 * on a PO whose effective status is ORDERED or PARTIAL (past DRAFT, not CANCELLED). Both the
 * scalar {@link onOrderQtyForItemSql} and the batch
 * {@link PurchaseOrderRepository.onOrderQtyForItems} read build on this one predicate so the
 * figure can never diverge between them.
 */
const ON_ORDER_LINE_PREDICATE = `l.ordered_qty > l.received_qty AND po.status NOT IN ('DRAFT', 'CANCELLED')`;

/**
 * Every purchase-order header read goes through this projection: the order's own columns plus
 * the canonical `suppliers.name` as `supplier_name`, which {@link rowToPurchaseOrder} surfaces
 * as the DTO's read-only `supplierName`. Defined once so no read can forget the join and hand
 * back an order with no supplier on it.
 */
const PURCHASE_ORDER_SELECT = `SELECT po.*, s.name AS supplier_name
                                 FROM purchase_orders po
                                 LEFT JOIN suppliers s ON s.id = po.supplier_id`;

/**
 * Correlated scalar subquery yielding the quantity of an item still **on order** — the sum of
 * outstanding `(ordered_qty − received_qty)` over its lines whose PO's effective status is
 * ORDERED or PARTIAL (past DRAFT, not CANCELLED, not fully received). This is the SQL form of
 * {@link PurchaseOrderRepository.onOrderQtyForItem}, shared so the reorder-shortfall query can
 * net already-incoming stock off what it suggests ordering without duplicating the definition.
 *
 * Pass a bound `'?'` (and bind the item id) for a standalone lookup, or an outer column
 * expression like `'i.id'` to correlate against an enclosing `items` row.
 */
export function onOrderQtyForItemSql(itemIdExpr: string): string {
  return `(SELECT COALESCE(SUM(l.ordered_qty - l.received_qty), 0)
             FROM purchase_order_lines l
             JOIN purchase_orders po ON po.id = l.po_id
            WHERE l.item_id = ${itemIdExpr}
              AND ${ON_ORDER_LINE_PREDICATE})`;
}

/** Trim a string field; an all-whitespace value becomes null (a genuinely absent field). */
function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate a nullable non-negative cost (the CHECK also enforces ≥ 0), returned in integer
 * micro-units — the on-disk money scale (issue #286).
 */
function cleanCost(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'A unit cost must be a non-negative number.');
  }
  return toStoredMoney(value);
}

/** Validate a required positive whole ordered quantity (the CHECK also enforces > 0). */
function cleanOrderedQty(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'An ordered quantity must be a positive whole number.');
  }
  return value;
}

export class PurchaseOrderRepository extends BaseRepository {
  private readonly suppliers: SupplierRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.suppliers = new SupplierRepository(driver, collaboratorOptions(options));
  }

  // --- purchase orders ---------------------------------------------------------

  async getById(id: string): Promise<PurchaseOrder | undefined> {
    const row = await this.driver.queryOne<PurchaseOrderRow>(`${PURCHASE_ORDER_SELECT} WHERE po.id = ?;`, [
      id,
    ]);
    return row ? rowToPurchaseOrder(row) : undefined;
  }

  /** Every purchase order, newest first, with its effective (derived) status for the list. */
  async list(params: PageParams = {}): Promise<Page<PurchaseOrderWithLines>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<PurchaseOrderRow>(
      `${PURCHASE_ORDER_SELECT} ORDER BY po.created_at DESC, po.id ASC LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    const withLines = await Promise.all(rows.map((row) => this.attachLines(row)));
    return this.toPage(withLines, limit, offset);
  }

  /**
   * How many purchase orders exist in total — the denominator behind the Orders tab's
   * pagination (issue #149). Orders accumulate for as long as the inventory is used, so the
   * master list pages server-side rather than showing a capped read as if it were the lot.
   */
  async count(): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_orders;');
    return Number(row?.n ?? 0);
  }

  /** A purchase order with its lines and effective status, or undefined. */
  async getWithLines(id: string): Promise<PurchaseOrderWithLines | undefined> {
    const row = await this.driver.queryOne<PurchaseOrderRow>(`${PURCHASE_ORDER_SELECT} WHERE po.id = ?;`, [
      id,
    ]);
    return row ? this.attachLines(row) : undefined;
  }

  async create(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    // Clean the plain fields BEFORE resolving the supplier — resolving can mint a supplier row
    // outside this write, so a later rejection would strand it in the dictionary.
    const reference = cleanText(input.reference);
    const currency = cleanText(input.currency);
    // A typed name folds onto the existing supplier (or mints one); an id is verified. The
    // order stores only the id, so a later rename carries through to its history.
    const supplierId = await this.suppliers.resolveRef(input.supplier);
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO purchase_orders (id, supplier_id, reference, currency)
       VALUES (?, ?, ?, ?);`,
      [id, supplierId, reference, currency],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrder> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    await this.require(id);
    const sets: string[] = [];
    const params: SqlValue[] = [];
    // Re-pointing the order at another supplier moves the id; it never edits a name in place —
    // renaming is the supplier's own operation and applies everywhere at once.
    if (input.supplier !== undefined) {
      sets.push('supplier_id = ?');
      params.push(await this.suppliers.resolveRef(input.supplier));
    }
    if (input.reference !== undefined) {
      sets.push('reference = ?');
      params.push(cleanText(input.reference));
    }
    if (input.currency !== undefined) {
      sets.push('currency = ?');
      params.push(cleanText(input.currency));
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?;`, params);
    }
    return (await this.getById(id))!;
  }

  /**
   * Set a PO's user-authoritative status. Only DRAFT / ORDERED / CANCELLED are settable here:
   * moving DRAFT → ORDERED stamps `ordered_at`; PARTIAL / RECEIVED are *derived* from receipts
   * (see {@link receiveLine} / {@link derivePoStatus}) and are never set by hand. Setting
   * ORDERED on an order that already has receipts immediately re-derives to PARTIAL / RECEIVED.
   */
  async setStatus(id: string, status: 'DRAFT' | 'ORDERED' | 'CANCELLED'): Promise<PurchaseOrder> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    await this.require(id);

    if (status === 'ORDERED') {
      // Persist the snapshot the lines actually imply (a part-received order surfaces as
      // PARTIAL/RECEIVED), and stamp ordered_at on the first transition out of DRAFT.
      const lines = await this.readLineProgress(id);
      const effective = derivePoStatus('ORDERED', lines);
      await this.driver.execute(
        `UPDATE purchase_orders
            SET status = ?, ordered_at = COALESCE(ordered_at, ${SQL_NOW_MS})
          WHERE id = ?;`,
        [effective, id],
      );
    } else {
      await this.driver.execute('UPDATE purchase_orders SET status = ? WHERE id = ?;', [status, id]);
    }
    return (await this.getById(id))!;
  }

  /** Delete a PO (its lines cascade). Bypasses the Hard Stop; tombstoned for sync (§7.2). */
  async delete(id: string): Promise<void> {
    this.assertPermission('purchase-orders:delete');
    // Tombstone the lines too so a peer drops them rather than re-downloading orphans.
    const lineIds = await this.driver.query<{ id: string }>(
      'SELECT id FROM purchase_order_lines WHERE po_id = ?;',
      [id],
    );
    const statements: SqlStatement[] = [
      { sql: 'DELETE FROM purchase_orders WHERE id = ?;', params: [id] },
      tombstoneStatement('purchase_orders', id),
    ];
    for (const { id: lineId } of lineIds) {
      statements.push(tombstoneStatement('purchase_order_lines', lineId));
    }
    await this.driver.transaction(statements);
  }

  // --- purchase-order lines ----------------------------------------------------

  async getLine(lineId: string): Promise<PurchaseOrderLine | undefined> {
    const row = await this.driver.queryOne<PurchaseOrderLineRow>(
      'SELECT * FROM purchase_order_lines WHERE id = ?;',
      [lineId],
    );
    return row ? rowToPurchaseOrderLine(row) : undefined;
  }

  /** Every line on a PO, oldest first (the order they were added). */
  async listLines(poId: string): Promise<PurchaseOrderLine[]> {
    const rows = await this.driver.query<PurchaseOrderLineRow>(
      'SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY created_at ASC, id ASC;',
      [poId],
    );
    return rows.map(rowToPurchaseOrderLine);
  }

  async addLine(poId: string, input: CreatePurchaseOrderLineInput): Promise<PurchaseOrderLine> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    await this.require(poId);
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO purchase_order_lines
         (id, po_id, item_id, supplier_part_id, description, ordered_qty, unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        poId,
        cleanText(input.itemId),
        cleanText(input.supplierPartId),
        cleanText(input.description),
        cleanOrderedQty(input.orderedQty),
        cleanCost(input.unitCost),
      ],
    );
    return (await this.getLine(id))!;
  }

  async updateLine(lineId: string, input: UpdatePurchaseOrderLineInput): Promise<PurchaseOrderLine> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    await this.requireLine(lineId);
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.itemId !== undefined) {
      sets.push('item_id = ?');
      params.push(cleanText(input.itemId));
    }
    if (input.supplierPartId !== undefined) {
      sets.push('supplier_part_id = ?');
      params.push(cleanText(input.supplierPartId));
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(cleanText(input.description));
    }
    if (input.orderedQty !== undefined) {
      sets.push('ordered_qty = ?');
      params.push(cleanOrderedQty(input.orderedQty));
    }
    if (input.unitCost !== undefined) {
      sets.push('unit_cost = ?');
      params.push(cleanCost(input.unitCost));
    }
    if (sets.length > 0) {
      params.push(lineId);
      await this.driver.execute(`UPDATE purchase_order_lines SET ${sets.join(', ')} WHERE id = ?;`, params);
    }
    return (await this.getLine(lineId))!;
  }

  /** Remove a line. Bypasses the Hard Stop; tombstoned for sync (§7.2). */
  async removeLine(lineId: string): Promise<void> {
    this.assertPermission('purchase-orders:write');
    await this.driver.transaction([
      { sql: 'DELETE FROM purchase_order_lines WHERE id = ?;', params: [lineId] },
      tombstoneStatement('purchase_order_lines', lineId),
    ]);
  }

  /**
   * Receive a PO line into active inventory, in whole or in instalments (§4 partial / split
   * receipts). Mirrors `ProjectRepository.receiveLine`: the accepted quantity (default: the
   * full outstanding remainder) is clamped by {@link planPoReceipt} and accumulated onto the
   * line's `received_qty`. For a matched DISCRETE item the received delta lands into the
   * per-location / per-batch ledger via the shared `addStockStatement` / `addBatchStatement`
   * builders and a `RECEIVED` history entry is logged — the same machinery BOM receipts use,
   * never a second path. The PO's persisted status snapshot is then re-derived.
   */
  async receiveLine(
    lineId: string,
    opts: { locationId?: string; quantity?: number; batch?: BatchIdentity } = {},
  ): Promise<PurchaseOrderLine> {
    this.assertPermission('purchase-orders:write');
    this.assertPermission('stock:write');
    this.assertWritable();
    const line = await this.requireLine(lineId);

    const plan = planPoReceipt(line.orderedQty, line.receivedQty, opts.quantity);

    const statements: SqlStatement[] = [
      {
        sql: 'UPDATE purchase_order_lines SET received_qty = ? WHERE id = ?;',
        params: [plan.nextReceivedQty, lineId],
      },
    ];

    if (line.itemId && plan.receivedDelta > 0) {
      const item = await this.driver.queryOne<{
        tracking_mode: string;
        quantity: number;
        location_id: string;
      }>('SELECT tracking_mode, quantity, location_id FROM items WHERE id = ?;', [line.itemId]);
      if (item && item.tracking_mode === 'DISCRETE') {
        const qty = plan.receivedDelta;
        const nextQty = item.quantity + qty;
        // Received stock lands at the destination location in the per-location ledger
        // (Phase 25); when that differs from the item's primary location the item simply
        // becomes multi-location (the units are physically wherever they arrived).
        const targetLocation = opts.locationId ?? item.location_id;

        // A receipt may land into a specific batch/lot (Phase 28): the units arrive tagged
        // with their manufacturing batch and expiry, so they enter that `stock_batches` row.
        // With no batch given they fall into the placement's untracked default batch.
        const batchKey = opts.batch ? batchKeyOf(opts.batch) : '';
        const batchNote =
          batchKey !== '' ? ` [batch ${opts.batch!.batchNumber ?? opts.batch!.lotNumber ?? '—'}]` : '';
        statements.push(
          opts.batch
            ? addBatchStatement(line.itemId, targetLocation, opts.batch, qty)
            : addStockStatement(line.itemId, targetLocation, qty),
        );
        statements.push(
          historyStatement(line.itemId, 'RECEIVED', this.actorId(), {
            quantityDelta: qty,
            note: plan.fullyReceived
              ? `Received ${qty} from a purchase order (now ${nextQty})${batchNote}.`
              : `Received ${qty} of ${line.orderedQty} from a purchase order (now ${nextQty}; ${plan.outstandingQty} still arriving)${batchNote}.`,
            metadata: targetLocation !== item.location_id ? { toLocationId: targetLocation } : undefined,
          }),
        );
      }
    }

    await this.driver.transaction(statements);

    // Re-derive and persist the PO status snapshot from the (now updated) line totals.
    await this.refreshStatus(line.poId);

    return (await this.getLine(lineId))!;
  }

  /**
   * Return (refund) a received PO line back to the supplier — the inverse of {@link receiveLine}.
   * The amount (default: everything received so far) is clamped by {@link planPoReturn} and
   * subtracted from the line's `received_qty`, so the PO status re-derives back towards PARTIAL /
   * ORDERED. For a matched DISCRETE item the returned units are drawn out of the per-location
   * ledger (FEFO at the target location) via the shared `placementDeltaStatements` builder and a
   * `RETURNED_TO_SUPPLIER` history entry is logged — never a second stock-mutation path.
   */
  async returnLine(
    lineId: string,
    opts: { locationId?: string; quantity?: number } = {},
  ): Promise<PurchaseOrderLine> {
    this.assertPermission('purchase-orders:write');
    this.assertPermission('stock:write');
    this.assertWritable();
    const line = await this.requireLine(lineId);

    const plan = planPoReturn(line.receivedQty, opts.quantity);
    if (plan.returnedDelta <= 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'There is nothing received on this line to return.');
    }

    const statements: SqlStatement[] = [
      {
        sql: 'UPDATE purchase_order_lines SET received_qty = ? WHERE id = ?;',
        params: [plan.nextReceivedQty, lineId],
      },
    ];

    if (line.itemId) {
      const item = await this.driver.queryOne<{ tracking_mode: string; location_id: string }>(
        'SELECT tracking_mode, location_id FROM items WHERE id = ?;',
        [line.itemId],
      );
      if (item && item.tracking_mode === 'DISCRETE') {
        const qty = plan.returnedDelta;
        const targetLocation = opts.locationId ?? item.location_id;

        // The units must still be on hand at the target location to send them back; guard for a
        // clear error rather than letting the CHECK (quantity >= 0) abort the transaction.
        const placement = await this.driver.queryOne<{ quantity: number }>(
          'SELECT quantity FROM item_stock WHERE id = ?;',
          [stockRowId(line.itemId, targetLocation)],
        );
        const available = Number(placement?.quantity ?? 0);
        if (available < qty) {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `Not enough stock at the return location to send back: ${available} on hand, ${qty} to return.`,
          );
        }

        const supplierName = await this.supplierNameFor(line.poId);
        statements.push(...(await placementDeltaStatements(this.driver, line.itemId, targetLocation, -qty)));
        statements.push(
          historyStatement(line.itemId, 'RETURNED_TO_SUPPLIER', this.actorId(), {
            quantityDelta: -qty,
            note: `Returned ${qty} to ${supplierName ?? 'the supplier'} (PO refund).`,
            metadata: {
              poId: line.poId,
              lineId,
              supplierName,
              unitCost: line.unitCost,
              quantity: qty,
              fromLocationId: targetLocation,
            },
          }),
        );
      }
    }

    await runStockDraw(this.driver, statements);

    // Re-derive and persist the PO status snapshot from the (now reduced) line totals.
    await this.refreshStatus(line.poId);

    return (await this.getLine(lineId))!;
  }

  /**
   * The total quantity of one item still **on order** across every active PO (spec §4) — the
   * sum of the outstanding `(ordered_qty − received_qty)` over its lines whose PO's effective
   * status is ORDERED or PARTIAL (i.e. the PO is past DRAFT, not CANCELLED, and not fully
   * received). A *derived projection* like the Phase-20 In-Transit one — receiving a line,
   * cancelling the PO, deleting the line or the PO (FK cascade), and LWW sync all keep this
   * figure correct with no stored counter to drift.
   *
   * `status NOT IN ('DRAFT','CANCELLED')` is the persisted gate; the per-line
   * `ordered_qty > received_qty` filter excludes already-received lines so the figure is the
   * genuine still-incoming quantity (a fully-received PO contributes nothing).
   */
  async onOrderQtyForItem(itemId: string): Promise<number> {
    const row = await this.driver.queryOne<{ qty: number }>(`SELECT ${onOrderQtyForItemSql('?')} AS qty;`, [
      itemId,
    ]);
    return Number(row?.qty ?? 0);
  }

  /**
   * The still-**on-order** quantity for a *set* of items, resolved in a single round-trip —
   * the batch companion to {@link onOrderQtyForItem}, so a caller surfacing "N on order" across
   * a whole low-stock list (the dashboard widget) reads it once rather than N+1 times. Shares
   * the {@link ON_ORDER_LINE_PREDICATE} definition, so a batched figure always matches the
   * scalar one.
   *
   * Returns a `Map` keyed by item id, containing an entry **only** for items that actually have
   * stock on order (the `GROUP BY` drops items with no outstanding lines) — a caller reads a
   * missing key as 0. An empty input set skips the query and returns an empty map.
   */
  async onOrderQtyForItems(itemIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (itemIds.length === 0) return result;
    const placeholders = itemIds.map(() => '?').join(', ');
    const rows = await this.driver.query<{ item_id: string; qty: number }>(
      `SELECT l.item_id AS item_id, COALESCE(SUM(l.ordered_qty - l.received_qty), 0) AS qty
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.item_id IN (${placeholders})
          AND ${ON_ORDER_LINE_PREDICATE}
        GROUP BY l.item_id;`,
      [...itemIds],
    );
    for (const r of rows) result.set(r.item_id, Number(r.qty));
    return result;
  }

  // --- reorder-plan bulk creation (Phase 65) -----------------------------------

  /**
   * Create one DRAFT purchase order per supplier group in the given reorder plan, adding one
   * line per item in the group. A group with a null `supplierId` is the **Unassigned** group —
   * items with no preferred supplier, which have nothing to key a PO on — and is skipped.
   *
   * This method composes the existing {@link create} + {@link addLine} path (no second
   * PO-creation path) so all the same validation, Hard-Stop gating, and tombstone
   * conventions apply. Returns the newly created POs with their lines.
   *
   * Status is left at DRAFT (`derivePoStatus` is authoritative — the caller must
   * explicitly set ORDERED when the orders have been sent).
   */
  async createDraftFromReorderPlan(groups: readonly ReorderPlanGroup[]): Promise<PurchaseOrderWithLines[]> {
    this.assertPermission('purchase-orders:write');
    this.assertWritable();
    const created: PurchaseOrderWithLines[] = [];

    for (const group of groups) {
      // The Unassigned group has no supplier to key a PO — skip it.
      if (group.supplierId === null) continue;
      if (group.lines.length === 0) continue;

      // The group already identifies its supplier, so pass the id straight through rather
      // than re-resolving a name that could fold onto a different row.
      const po = await this.create({ supplier: { supplierId: group.supplierId } });

      for (const line of group.lines) {
        await this.addLine(po.id, {
          itemId: line.itemId,
          supplierPartId: line.supplierPartId ?? undefined,
          orderedQty: line.orderQty,
          unitCost: line.unitCost ?? undefined,
        });
      }

      const withLines = await this.getWithLines(po.id);
      if (withLines) created.push(withLines);
    }

    return created;
  }

  // --- internals ---------------------------------------------------------------

  private async attachLines(row: PurchaseOrderRow): Promise<PurchaseOrderWithLines> {
    const lines = await this.listLines(row.id);
    const po = rowToPurchaseOrder(row);
    return {
      ...po,
      lines,
      effectiveStatus: derivePoStatus(po.status, lines),
    };
  }

  /** The supplier name on a PO header, for a return's ledger note; null if the PO is gone. */
  /** The order's supplier name, or null when it has none / the supplier has been deleted. */
  private async supplierNameFor(poId: string): Promise<string | null> {
    const row = await this.driver.queryOne<{ supplier_name: string | null }>(
      `SELECT s.name AS supplier_name
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.id = ?;`,
      [poId],
    );
    return row ? row.supplier_name : null;
  }

  /** Read just the (orderedQty, receivedQty) of a PO's lines for status derivation. */
  private async readLineProgress(poId: string): Promise<PoStatusLine[]> {
    const rows = await this.driver.query<{ ordered_qty: number; received_qty: number }>(
      'SELECT ordered_qty, received_qty FROM purchase_order_lines WHERE po_id = ?;',
      [poId],
    );
    return rows.map((r) => ({ orderedQty: Number(r.ordered_qty), receivedQty: Number(r.received_qty) }));
  }

  /**
   * Recompute and persist a PO's status snapshot from its line totals — unless the PO is in a
   * user-authoritative state (DRAFT / CANCELLED), which {@link derivePoStatus} leaves alone.
   */
  private async refreshStatus(poId: string): Promise<void> {
    const po = await this.getById(poId);
    if (!po) return;
    const next: PurchaseOrderStatus = derivePoStatus(po.status, await this.readLineProgress(poId));
    if (next !== po.status) {
      await this.driver.execute('UPDATE purchase_orders SET status = ? WHERE id = ?;', [next, poId]);
    }
  }

  private async require(id: string): Promise<PurchaseOrder> {
    const po = await this.getById(id);
    if (!po) {
      throw new DbError('SQLITE_CONSTRAINT', `Purchase order "${id}" does not exist.`);
    }
    return po;
  }

  private async requireLine(lineId: string): Promise<PurchaseOrderLine> {
    const line = await this.getLine(lineId);
    if (!line) {
      throw new DbError('SQLITE_CONSTRAINT', `Purchase order line "${lineId}" does not exist.`);
    }
    return line;
  }
}
