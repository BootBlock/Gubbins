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
 * All SQL lives over the injected driver (§2.1.1). Creation grows storage and is Hard-Stop
 * gated; deletes (which free space) are not and record a tombstone in the same transaction so
 * the deletion syncs (§7.2).
 */
import { batchKeyOf, type BatchIdentity } from '@/features/inventory/batches';
import { SQL_NOW_MS } from '../migrations/migration';
import { planPoReceipt } from '@/features/purchasing/po-receipt';
import { derivePoStatus, type PoStatusLine } from '@/features/purchasing/po-status';
import { UNASSIGNED_SUPPLIER_NAME, type ReorderPlanGroup } from '@/features/purchasing/reorder-plan';
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { historyStatement } from './item/history';
import { rowToPurchaseOrder, rowToPurchaseOrderLine } from './mappers';
import { addStockStatement } from './stock';
import { addBatchStatement } from './stock-batches';
import { tombstoneStatement } from './tombstone';
import type { SqlStatement, SqlValue } from '../rpc/driver';
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

/** Validate a required positive whole ordered quantity (the CHECK also enforces > 0). */
function cleanOrderedQty(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'An ordered quantity must be a positive whole number.');
  }
  return value;
}

export class PurchaseOrderRepository extends BaseRepository {
  // --- purchase orders ---------------------------------------------------------

  async getById(id: string): Promise<PurchaseOrder | undefined> {
    const row = await this.driver.queryOne<PurchaseOrderRow>('SELECT * FROM purchase_orders WHERE id = ?;', [
      id,
    ]);
    return row ? rowToPurchaseOrder(row) : undefined;
  }

  /** Every purchase order, newest first, with its effective (derived) status for the list. */
  async list(params: PageParams = {}): Promise<Page<PurchaseOrderWithLines>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<PurchaseOrderRow>(
      'SELECT * FROM purchase_orders ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?;',
      [limit, offset],
    );
    const withLines = await Promise.all(rows.map((row) => this.attachLines(row)));
    return this.toPage(withLines, limit, offset);
  }

  /** A purchase order with its lines and effective status, or undefined. */
  async getWithLines(id: string): Promise<PurchaseOrderWithLines | undefined> {
    const row = await this.driver.queryOne<PurchaseOrderRow>('SELECT * FROM purchase_orders WHERE id = ?;', [
      id,
    ]);
    return row ? this.attachLines(row) : undefined;
  }

  async create(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    this.assertWritable();
    const supplierName = cleanText(input.supplierName);
    if (!supplierName) {
      throw new DbError('SQLITE_CONSTRAINT', 'A purchase order must have a supplier name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO purchase_orders (id, supplier_name, reference, currency)
       VALUES (?, ?, ?, ?);`,
      [id, supplierName, cleanText(input.reference), cleanText(input.currency)],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrder> {
    this.assertWritable();
    await this.require(id);
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.supplierName !== undefined) {
      const name = cleanText(input.supplierName);
      if (!name) {
        throw new DbError('SQLITE_CONSTRAINT', 'A purchase order must have a supplier name.');
      }
      sets.push('supplier_name = ?');
      params.push(name);
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
          historyStatement(line.itemId, 'RECEIVED', {
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
    const row = await this.driver.queryOne<{ qty: number }>(
      `SELECT COALESCE(SUM(l.ordered_qty - l.received_qty), 0) AS qty
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.item_id = ?
          AND l.ordered_qty > l.received_qty
          AND po.status NOT IN ('DRAFT', 'CANCELLED');`,
      [itemId],
    );
    return Number(row?.qty ?? 0);
  }

  // --- reorder-plan bulk creation (Phase 65) -----------------------------------

  /**
   * Create one DRAFT purchase order per named supplier group in the given reorder plan,
   * adding one line per item in the group. The **Unassigned** group is skipped — items
   * without a preferred supplier have no supplier name to key a PO.
   *
   * This method composes the existing {@link create} + {@link addLine} path (no second
   * PO-creation path) so all the same validation, Hard-Stop gating, and tombstone
   * conventions apply. Returns the newly created POs with their lines.
   *
   * Status is left at DRAFT (`derivePoStatus` is authoritative — the caller must
   * explicitly set ORDERED when the orders have been sent).
   */
  async createDraftFromReorderPlan(groups: readonly ReorderPlanGroup[]): Promise<PurchaseOrderWithLines[]> {
    this.assertWritable();
    const created: PurchaseOrderWithLines[] = [];

    for (const group of groups) {
      // The Unassigned group has no supplier to key a PO — skip it.
      if (group.supplierName === UNASSIGNED_SUPPLIER_NAME) continue;
      if (group.lines.length === 0) continue;

      const po = await this.create({ supplierName: group.supplierName });

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
