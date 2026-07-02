/**
 * Reservations & procurement concern (spec §4 Tentative vs Actual, the liminal
 * "In Transit" procurement lifecycle).
 *
 * Reservations are ledger annotations on a BOM line: they do not mutate an item's
 * on-hand `quantity` (which tracks physical stock). Every change that affects a
 * *matched* inventory item also appends to the immutable Activity Log (`item_history`)
 * in the same transaction, so the ledger never drifts. In-Transit quantity is a
 * *derived projection* of the BOM lines, never a stored counter.
 */
import { batchKeyOf, type BatchIdentity } from '@/features/inventory/batches';
import { planReceipt } from '@/features/projects/receipts';
import type { SqlStatement } from '../../rpc/driver';
import type { ProcurementStatus, ReservationStatus } from '../constants';
import { historyStatement } from '../item/history';
import { addStockStatement } from '../stock';
import { addBatchStatement } from '../stock-batches';
import type { InTransitLine, Page, PageParams, ProjectBomLine } from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

export function withProcurement<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectProcurementRepository extends Base {
    // --- reservations (spec §4 Tentative vs Actual) ------------------------------

    /**
     * Set a BOM line's reservation. TENTATIVE is a soft hold; ACTUAL commits stock
     * and is recorded in the matched item's Activity Log (§4). The reserved quantity
     * defaults to the full requirement and is clamped to it. NONE clears the hold.
     */
    async setReservation(lineId: string, status: ReservationStatus, qty?: number): Promise<ProjectBomLine> {
      this.assertWritable();
      const { line } = await this.requireLine(lineId);

      const reservedQty =
        status === 'NONE' ? 0 : Math.max(0, Math.min(line.requiredQty, Math.floor(qty ?? line.requiredQty)));

      const statements: SqlStatement[] = [
        {
          sql: 'UPDATE project_bom_lines SET reservation_status = ?, reserved_qty = ? WHERE id = ?;',
          params: [status, reservedQty, lineId],
        },
      ];

      if (line.itemId) {
        const enteringActual = status === 'ACTUAL' && line.reservationStatus !== 'ACTUAL';
        const leavingActual = status !== 'ACTUAL' && line.reservationStatus === 'ACTUAL';
        if (enteringActual) {
          statements.push(
            historyStatement(line.itemId, 'RESERVED', {
              quantityDelta: reservedQty,
              note: `Reserved ${reservedQty} for a project.`,
            }),
          );
        } else if (leavingActual) {
          statements.push(
            historyStatement(line.itemId, 'RESERVATION_CLEARED', {
              note: 'Project reservation released.',
            }),
          );
        }
      }

      await this.driver.transaction(statements);
      return (await this.requireLine(lineId)).line;
    }

    // --- procurement & In-Transit (spec §4 liminal procurement) ------------------

    /**
     * Move a BOM line through the procurement lifecycle (Ordered → In-Transit →
     * Received). Entering IN_TRANSIT logs a PROCURED entry against a matched item,
     * marking incoming stock as arriving (the "In Transit" liminal state, §4).
     */
    async setProcurement(lineId: string, status: ProcurementStatus): Promise<ProjectBomLine> {
      this.assertWritable();
      const { line } = await this.requireLine(lineId);

      const statements: SqlStatement[] = [
        {
          sql: 'UPDATE project_bom_lines SET procurement_status = ? WHERE id = ?;',
          params: [status, lineId],
        },
      ];
      if (line.itemId && status === 'IN_TRANSIT' && line.procurementStatus !== 'IN_TRANSIT') {
        statements.push(
          historyStatement(line.itemId, 'PROCURED', {
            quantityDelta: line.requiredQty,
            note: `${line.requiredQty} in transit for a project.`,
          }),
        );
      }
      await this.driver.transaction(statements);
      return (await this.requireLine(lineId)).line;
    }

    /**
     * Receive an ordered line into active inventory, in whole or in instalments (§4
     * partial / split receipts). The accepted quantity (default: the full outstanding
     * remainder) is clamped to what is still outstanding and accumulated onto the line's
     * `received_qty`; the line only flips to RECEIVED once cumulative receipts meet the
     * requirement, otherwise it stays IN_TRANSIT so the remainder keeps surfacing as
     * incoming stock (`inTransitQtyForItem`). For a matched DISCRETE item the received
     * delta is added to its on-hand stock and, if a destination is given, it is moved
     * there — both logged to the ledger. Non-discrete / unmatched lines just track the
     * received progress and transition to RECEIVED when complete.
     */
    async receiveLine(
      lineId: string,
      opts: { locationId?: string; quantity?: number; batch?: BatchIdentity } = {},
    ): Promise<ProjectBomLine> {
      this.assertWritable();
      const { line } = await this.requireLine(lineId);

      const plan = planReceipt(line.requiredQty, line.receivedQty, opts.quantity);
      const nextStatus: ProcurementStatus = plan.fullyReceived ? 'RECEIVED' : line.procurementStatus;

      const statements: SqlStatement[] = [
        {
          sql: 'UPDATE project_bom_lines SET received_qty = ?, procurement_status = ? WHERE id = ?;',
          params: [plan.nextReceivedQty, nextStatus, lineId],
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
                ? `Received ${qty} from procurement (now ${nextQty})${batchNote}.`
                : `Received ${qty} of ${line.requiredQty} from procurement (now ${nextQty}; ${plan.outstandingQty} still arriving)${batchNote}.`,
              metadata: targetLocation !== item.location_id ? { toLocationId: targetLocation } : undefined,
            }),
          );
        }
      }

      await this.driver.transaction(statements);
      return (await this.requireLine(lineId)).line;
    }

    /**
     * Every BOM line currently In Transit across all projects (spec §4 procurement),
     * newest project first — the dashboard "In Transit" tracker feed. Bounded by the
     * number of outstanding orders, but paginated per the §2.1 mandate.
     */
    async listInTransit(params: PageParams = {}): Promise<Page<InTransitLine>> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<{
        line_id: string;
        project_id: string;
        project_name: string;
        item_id: string | null;
        label: string | null;
        required_qty: number;
        received_qty: number;
      }>(
        `SELECT
           l.id AS line_id,
           l.project_id AS project_id,
           p.name AS project_name,
           l.item_id AS item_id,
           COALESCE(i.name, l.description, l.mpn, l.designator) AS label,
           l.required_qty AS required_qty,
           l.received_qty AS received_qty
         FROM project_bom_lines l
         JOIN projects p ON p.id = l.project_id
         LEFT JOIN items i ON i.id = l.item_id
         WHERE l.procurement_status = 'IN_TRANSIT'
         ORDER BY p.created_at DESC, label COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [limit, offset],
      );
      const mapped = rows.map<InTransitLine>((r) => ({
        lineId: r.line_id,
        projectId: r.project_id,
        projectName: r.project_name,
        itemId: r.item_id,
        label: r.label ?? 'Unknown part',
        requiredQty: Number(r.required_qty),
        receivedQty: Number(r.received_qty),
      }));
      return this.toPage(mapped, limit, offset);
    }

    /**
     * The total quantity of one item currently In Transit (spec §4 "The Liminal Space
     * of Procurement") — the sum of `required_qty` over every BOM line, across all
     * projects, matched to this item and sitting at `procurement_status = 'IN_TRANSIT'`.
     *
     * This is a *derived projection* of the BOM lines (the §2.1 single source of truth),
     * never a stored counter: receiving a line (→ RECEIVED), reverting its status,
     * deleting the line or its whole project (FK cascade), and LWW sync of the line's
     * status all keep this figure correct with no denormalised bookkeeping to drift. It
     * is the item's distinct "incoming stock" quantity — conceptually held in the
     * system-locked In-Transit location — kept separate from the on-hand `quantity`
     * rather than overloaded onto it. With partial / split receipts (§4, Phase 24) it is
     * the *outstanding* remainder (`required − received`) of each still-IN_TRANSIT line,
     * so a part-received order surfaces only the quantity still to arrive.
     */
    async inTransitQtyForItem(itemId: string): Promise<number> {
      const row = await this.driver.queryOne<{ qty: number }>(
        `SELECT COALESCE(SUM(MAX(required_qty - received_qty, 0)), 0) AS qty
           FROM project_bom_lines
          WHERE item_id = ? AND procurement_status = 'IN_TRANSIT';`,
        [itemId],
      );
      return Number(row?.qty ?? 0);
    }
  };
}
