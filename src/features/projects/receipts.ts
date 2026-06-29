/**
 * Pure procurement-receipt maths (spec §4 "The Liminal Space of Procurement").
 *
 * A BOM line is received into stock in one or more instalments (a partial / split
 * receipt). The cumulative `received_qty` is the line's *primary* record of how much
 * has physically arrived — not a derived projection, but the source of truth for the
 * instalment progress — while the *outstanding* (still-incoming) quantity is derived
 * from it (`required − received`). Keeping this arithmetic pure and isolated mirrors
 * the `cycle-count.ts` reconciliation seam: the repository trusts this plan and only
 * persists the result.
 */

export interface ReceiptPlan {
  /** Units accepted by this instalment — clamped to the outstanding remainder. */
  readonly receivedDelta: number;
  /** Cumulative received quantity after this instalment. */
  readonly nextReceivedQty: number;
  /** Quantity still to arrive after this instalment (never negative). */
  readonly outstandingQty: number;
  /** True once the cumulative received quantity meets the requirement. */
  readonly fullyReceived: boolean;
}

/**
 * Plan a single receipt instalment against a line's requirement and prior receipts.
 *
 * - `requestedQty` omitted → receive the whole outstanding remainder (the common
 *   "receive it all" action, and the pre-Phase-24 wholesale behaviour).
 * - A requested quantity is floored to a whole unit, never negative, and clamped to
 *   the outstanding remainder so a receipt can never overshoot the requirement.
 * - The line is `fullyReceived` only once cumulative receipts reach the requirement;
 *   until then it stays open for further instalments.
 */
export function planReceipt(
  requiredQty: number,
  receivedQty: number,
  requestedQty?: number,
): ReceiptPlan {
  const remaining = Math.max(0, requiredQty - receivedQty);
  const requested =
    requestedQty === undefined ? remaining : Math.max(0, Math.floor(requestedQty));
  const receivedDelta = Math.min(requested, remaining);
  const nextReceivedQty = receivedQty + receivedDelta;
  return {
    receivedDelta,
    nextReceivedQty,
    outstandingQty: Math.max(0, requiredQty - nextReceivedQty),
    fullyReceived: nextReceivedQty >= requiredQty,
  };
}

/** The still-incoming quantity of a line — its requirement less what has arrived. */
export function outstandingQty(line: {
  readonly requiredQty: number;
  readonly receivedQty: number;
}): number {
  return Math.max(0, line.requiredQty - line.receivedQty);
}
