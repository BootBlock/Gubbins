/**
 * Pure purchase-order status derivation (spec §4 procurement; Inventory-depth Phase 62).
 *
 * A PO's effective status is **derived**, not stored: DRAFT and CANCELLED are the only
 * user-set authoritative states; for everything else the status follows the lines' receipt
 * progress (SUM received vs SUM ordered). Keeping this a pure, dependency-free seam mirrors
 * the `po-receipt.ts` / `receipts.ts` extract-the-logic pattern — the repository trusts this
 * function and only persists the resulting snapshot.
 *
 *   - persisted DRAFT or CANCELLED       → that wins (the user said so);
 *   - otherwise, nothing received yet     → ORDERED;
 *   - otherwise, some but not all received → PARTIAL;
 *   - otherwise (all received)            → RECEIVED.
 *
 * An order with no lines (or only zero-ordered lines) that is past DRAFT is treated as
 * ORDERED — there is nothing yet to have received.
 */
import type { PurchaseOrderStatus } from '@/db/repositories/types';

/** The minimal line shape the derivation reads. */
export interface PoStatusLine {
  readonly orderedQty: number;
  readonly receivedQty: number;
}

/**
 * Derive a PO's effective status from its persisted status and its lines. DRAFT / CANCELLED
 * are authoritative and returned unchanged; any other persisted value is recomputed from the
 * receipt totals so a stored ORDERED/PARTIAL/RECEIVED snapshot can never go stale.
 */
export function derivePoStatus(
  persistedStatus: PurchaseOrderStatus,
  lines: readonly PoStatusLine[],
): PurchaseOrderStatus {
  if (persistedStatus === 'DRAFT' || persistedStatus === 'CANCELLED') {
    return persistedStatus;
  }

  let ordered = 0;
  let received = 0;
  for (const line of lines) {
    ordered += Math.max(0, line.orderedQty);
    // A receipt can never exceed what was ordered (`planPoReceipt` clamps it), but guard
    // against a malformed snapshot so "all received" is detected reliably.
    received += Math.max(0, Math.min(line.receivedQty, Math.max(0, line.orderedQty)));
  }

  if (received <= 0) return 'ORDERED';
  if (received >= ordered) return 'RECEIVED';
  return 'PARTIAL';
}
