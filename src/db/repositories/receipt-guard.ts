/**
 * The compare-and-swap guard shared by every cumulative `received_qty` write (issue #298,
 * issue #485).
 *
 * A receipt is planned from a read of the line taken *before* the transaction, but the stock
 * statement it pairs with is **relative** (`addStockStatement` / `addBatchStatement` add units to
 * the ledger). Writing the plan's absolute total back therefore let two overlapping receipts each
 * add their units while the second's write silently replaced the first's total — the line reading
 * 10 received against 20 units on the shelf, permanently and with nothing on screen to show it.
 *
 * Purchase-order lines and project BOM lines are the two tables that carry such a counter, and
 * both receive through the very same statement builders, so they guard it the same way here
 * rather than growing a second implementation.
 */
import { DbError } from '../errors';
import type { SqlStatement } from '../rpc/driver';

/** The two tables carrying a cumulative `received_qty` a receipt accumulates onto. */
export type ReceiptLineTable = 'purchase_order_lines' | 'project_bom_lines';

/**
 * The compare-and-swap write of a line's cumulative `received_qty`.
 *
 * The write is relative *and* gated on the line still holding the value the plan was built from.
 * When it doesn't, the guard writes the sentinel `-1`, which trips the line's
 * `CHECK (received_qty >= 0)` and rolls the whole transaction back — the stock, the ledger entry
 * and any status write with it, so nothing is half-applied. That constraint is the same backstop
 * `runStockDraw` leans on for an overlapping stock draw (issue #302), and {@link runReceiptWrite}
 * translates it the same way so the loser reads a plain sentence rather than constraint text.
 *
 * `delta` is signed: a receipt adds, a return subtracts.
 */
export function receivedQtyDeltaStatement(
  table: ReceiptLineTable,
  lineId: string,
  expectedQty: number,
  delta: number,
): SqlStatement {
  return {
    sql: `UPDATE ${table}
             SET received_qty = CASE WHEN received_qty = ? THEN received_qty + ? ELSE -1 END
           WHERE id = ?;`,
    params: [expectedQty, delta, lineId],
  };
}

/**
 * The user-facing sentence for a purchase-order receipt or return that lost a race. An authored
 * sentence under a constraint code is kept verbatim by the error-copy seam (issue #311), exactly
 * as `STOCK_DRAW_RACE_MESSAGE` is.
 */
export const PO_RECEIPT_RACE_MESSAGE =
  'This purchase-order line changed while the receipt was being saved. ' +
  'Check the received quantity and try again.';

/** The same sentence for a project BOM line (issue #485). */
export const BOM_RECEIPT_RACE_MESSAGE =
  'This BOM line changed while the receipt was being saved. Check the received quantity and try again.';

/**
 * True when the {@link receivedQtyDeltaStatement} guard's sentinel tripped the line's
 * `CHECK (received_qty >= 0)`. Keyed on the message alone rather than the code, for the reason
 * `isQuantityFloorViolation` documents: the three drivers report the very same failure under
 * different codes, so a code set would silently miss in the browser.
 */
export function isReceivedQtyGuardViolation(error: unknown): boolean {
  if (!(error instanceof DbError)) return false;
  return /CHECK constraint failed:\s*received_qty >= 0/i.test(error.message);
}

/** Run a receipt/return write, translating the guard's abort into plain validation copy. */
export async function runReceiptWrite(run: () => Promise<void>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isReceivedQtyGuardViolation(error)) {
      throw new DbError('SQLITE_CONSTRAINT', message, { cause: error });
    }
    throw error;
  }
}
