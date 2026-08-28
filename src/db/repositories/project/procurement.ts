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
import { planReceipt, receiptLandingFor, recordOnlyReceiptReason } from '@/features/projects/receipts';
import type { SqlStatement } from '../../rpc/driver';
import type { ProcurementStatus, ReservationStatus, TrackingMode } from '../constants';
import { historyStatement } from '../item/history';
import { BOM_RECEIPT_RACE_MESSAGE, receivedQtyDeltaStatement, runReceiptWrite } from '../receipt-guard';
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
     *
     * The ledger entry carries the quantity in its `metadata` and note, and leaves
     * `quantity_delta` null (issue #652): a reservation is an *intent*, and no stock
     * has moved. Every report that reads the ledger — `movement`, `turnover`,
     * `valuationTrend` — sums `quantity_delta` without filtering on `action`, so a
     * delta here would be counted as a real arrival that never happened, and the
     * `RESERVATION_CLEARED` entry (which has nothing to reverse) would never undo it.
     */
    async setReservation(lineId: string, status: ReservationStatus, qty?: number): Promise<ProjectBomLine> {
      this.assertPermission('projects:write');
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
            historyStatement(line.itemId, 'RESERVED', this.actorId(), {
              metadata: { quantity: reservedQty },
              note: `Reserved ${reservedQty} for a project.`,
            }),
          );
        } else if (leavingActual) {
          statements.push(
            historyStatement(line.itemId, 'RESERVATION_CLEARED', this.actorId(), {
              metadata: { quantity: line.reservedQty },
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
     *
     * Like a reservation, that entry records its quantity in `metadata` and the note
     * only, never as a `quantity_delta` (issue #652): the units are still in transit,
     * and {@link receiveLine} logs the one real movement when they actually land.
     */
    async setProcurement(lineId: string, status: ProcurementStatus): Promise<ProjectBomLine> {
      this.assertPermission('projects:write');
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
          historyStatement(line.itemId, 'PROCURED', this.actorId(), {
            metadata: { quantity: line.requiredQty },
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
     * there — both logged to the ledger.
     *
     * A matched item whose tracking mode holds no counted quantity — serialised, consumable
     * or untracked — is **record-only** (issue #608): the line's progress and status advance
     * as before and no stock moves, but the receipt is still written to the item's Activity
     * Log saying so. It used to write nothing at all, which made the whole flow a silent
     * no-op with no entry to explain the unchanged on-hand figure. Which modes land stock is
     * {@link receiptLandingFor}'s decision, shared with the receive dialogs so the two cannot
     * promise different things. An *unmatched* line (no `itemId`) has no item to log against,
     * so it still only tracks the received progress.
     */
    async receiveLine(
      lineId: string,
      opts: { locationId?: string; quantity?: number; batch?: BatchIdentity } = {},
    ): Promise<ProjectBomLine> {
      this.assertPermission('projects:write');
      this.assertPermission('stock:write');
      this.assertWritable();
      const { line } = await this.requireLine(lineId);

      const plan = planReceipt(line.requiredQty, line.receivedQty, opts.quantity);
      const nextStatus: ProcurementStatus = plan.fullyReceived ? 'RECEIVED' : line.procurementStatus;

      // The cumulative total is written *relatively* and gated on the line still holding the value
      // this plan was built from (issue #485) — the stock statement it pairs with is relative too,
      // so an absolute write let two overlapping receipts each add their units while the second
      // silently replaced the first's total. Receiving nothing (an already-complete line) changes
      // no quantity, so it skips the guarded write rather than racing over a value it is not
      // changing; the status write below still gets its chance to catch up.
      const statements: SqlStatement[] =
        plan.receivedDelta > 0
          ? [receivedQtyDeltaStatement('project_bom_lines', lineId, line.receivedQty, plan.receivedDelta)]
          : [];
      statements.push({
        sql: 'UPDATE project_bom_lines SET procurement_status = ? WHERE id = ?;',
        params: [nextStatus, lineId],
      });

      if (line.itemId && plan.receivedDelta > 0) {
        const item = await this.driver.queryOne<{
          tracking_mode: TrackingMode;
          quantity: number;
          location_id: string;
        }>('SELECT tracking_mode, quantity, location_id FROM items WHERE id = ?;', [line.itemId]);
        const landing = item ? receiptLandingFor(item.tracking_mode) : null;
        if (item && landing === 'COUNT') {
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
                ? `Received ${qty} from procurement (now ${nextQty})${batchNote}.`
                : `Received ${qty} of ${line.requiredQty} from procurement (now ${nextQty}; ${plan.outstandingQty} still arriving)${batchNote}.`,
              metadata: targetLocation !== item.location_id ? { toLocationId: targetLocation } : undefined,
            }),
          );
        } else if (item && landing === 'RECORD_ONLY') {
          // The delivery happened even though no stock could move, so it is logged against the
          // item rather than left invisible (issue #608). `quantity_delta` stays null for the
          // same reason `setReservation` leaves it null: the movement reports sum that column
          // without filtering on `action`, so a delta here would be counted as a real arrival
          // that never took place.
          const qty = plan.receivedDelta;
          statements.push(
            historyStatement(line.itemId, 'RECEIVED', this.actorId(), {
              note: `Received ${qty} of ${line.requiredQty} from procurement. No stock was added: ${recordOnlyReceiptReason(item.tracking_mode)}.`,
              metadata: { lineId, quantity: qty, trackingMode: item.tracking_mode },
            }),
          );
        }
      }

      await runReceiptWrite(() => this.driver.transaction(statements), BOM_RECEIPT_RACE_MESSAGE);
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
