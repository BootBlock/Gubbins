/**
 * Pure purchase-order receipt planning (spec §4 procurement; Inventory-depth Phase 62).
 *
 * Receiving a PO line is the same arithmetic as receiving a BOM line: a single instalment is
 * clamped to the still-outstanding remainder and accumulated onto the line's `received_qty`.
 * Rather than re-implement that clamp, this **wraps** the Phase-24 `planReceipt` from
 * `features/projects/receipts.ts` (the single source of the receipt maths) and re-exposes its
 * plan under PO-domain field names, so there is exactly one place the clamp lives.
 */
import { planReceipt, type ReceiptPlan } from '@/features/projects/receipts';

export interface PoReceiptPlan {
  /** Units accepted by this instalment — clamped to the outstanding remainder. */
  readonly receivedDelta: number;
  /** Cumulative received quantity after this instalment. */
  readonly nextReceivedQty: number;
  /** Quantity still to arrive after this instalment (never negative). */
  readonly outstandingQty: number;
  /** True once cumulative receipts meet the ordered quantity. */
  readonly fullyReceived: boolean;
}

/**
 * Plan a single receipt instalment for a PO line.
 *
 * - `requestedQty` omitted → receive the whole outstanding remainder ("receive all").
 * - A requested quantity is floored to a whole unit, never negative, and clamped to the
 *   outstanding remainder so a receipt can never overshoot the ordered quantity.
 * - `fullyReceived` flips only once cumulative receipts reach `orderedQty`.
 */
export function planPoReceipt(orderedQty: number, receivedQty: number, requestedQty?: number): PoReceiptPlan {
  const plan: ReceiptPlan = planReceipt(orderedQty, receivedQty, requestedQty);
  return {
    receivedDelta: plan.receivedDelta,
    nextReceivedQty: plan.nextReceivedQty,
    outstandingQty: plan.outstandingQty,
    fullyReceived: plan.fullyReceived,
  };
}

export interface PoReturnPlan {
  /** Units returned to the supplier by this instalment — clamped to what was received. */
  readonly returnedDelta: number;
  /** Cumulative received quantity after the return (never negative). */
  readonly nextReceivedQty: number;
}

/**
 * Plan a single **return-to-supplier** instalment for a PO line — the inverse of
 * {@link planPoReceipt}. You can only return what has actually been received, so the amount is
 * floored, never negative, and clamped to the current `received_qty`.
 *
 * - `requestedQty` omitted → return everything received so far ("return all").
 * - The line's cumulative `received_qty` is reduced by the returned amount, flooring at zero, so
 *   the PO status re-derives back towards PARTIAL / ORDERED.
 */
export function planPoReturn(receivedQty: number, requestedQty?: number): PoReturnPlan {
  const received = Math.max(0, Math.floor(receivedQty));
  const requested = requestedQty === undefined ? received : Math.max(0, Math.floor(requestedQty));
  const returnedDelta = Math.min(requested, received);
  return { returnedDelta, nextReceivedQty: received - returnedDelta };
}
