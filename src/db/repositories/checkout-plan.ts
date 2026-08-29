/**
 * Check-in **planning** (issue #301) — the read-and-decide half of a loan return, split out
 * of {@link CheckoutRepository.checkIn} so a return's statements can be *composed* into a
 * larger transaction instead of only ever being executed on their own.
 *
 * Returning a loan is several writes (restore the stock lot, stamp `returned_at`, log
 * `CHECKED_IN`, maybe record a condition change). Deleting a borrower is "return everything
 * they still hold, then delete them". Run as separate awaited transactions, a failure part-way
 * leaves every loan force-returned against a borrower that still exists — so the whole thing
 * has to land or none of it. This module returns statements; the caller decides which
 * transaction they ride in.
 *
 * Deliberately free functions over a plain driver rather than methods on the repository:
 * `ContactRepository` / `ProjectRepository` / `LocationRepository` splice these into their own
 * delete transactions, and importing the checkout *class* from any of them would close an
 * import cycle (`CheckoutRepository` already imports `ContactRepository`).
 */
import { DbError } from '../errors';
import { SQL_NOW_MS } from '../migrations';
import type { IDatabaseDriver, SqlStatement, SqlValue } from '../rpc/driver';
import type { BorrowerType, Condition } from './constants';
import { historyStatement } from './item/history';
import { addBatchStatement, UNTRACKED_BATCH, withOperationKey } from './stock-batches';
import { batchIdentityFromKey } from '@/features/inventory/batches';
import { uuidv5 } from '@/lib/derived-uuid';
import type { CheckoutRow } from './types';

/**
 * Namespace for the deterministic ids a **return** writes (issue #542).
 *
 * Returning is a one-shot terminal operation on one loan: a loan goes out, comes back, and stays
 * back, so a given `checkouts` row can only ever be returned once. Two devices holding that row
 * can each return it while offline, though — and left to `randomblob()` each device's copy of the
 * one restore carried its own `stock_deltas` id, so the id-union replay in `reconcileStockQuantity`
 * read the two copies as two movements and gave the units back twice. Deriving them from the
 * checkout id makes both devices compute the same id, so the union sees the single return it was.
 *
 * The same fix issue #696 gave the assembly draw, applied to the other end of a loan. It matters
 * for every loan two devices can hold, but #542 is what made it acute: a booking conversion now
 * derives its `checkouts` id, so both devices' conversions *are* one row, and the draw they
 * collapsed would otherwise be given back by two independent restores.
 */
const CHECKOUT_RETURN_NAMESPACE = '9b7c1f0a-1950-4e00-8b00-000000005420';

/**
 * The deterministic id a return gives to `kind` for `checkoutId` (see
 * {@link CHECKOUT_RETURN_NAMESPACE}). A pure function of its inputs, which is the convergence
 * property: two devices returning the same loan offline derive the same ids.
 *
 * `fromReturned` is the loan's return watermark *before* this instalment (issue #662), which is
 * what makes a loan returned in stages derive a distinct id per stage rather than collapsing them
 * all into one. It is deliberately absent from the key at 0 rather than appended as `@0`: a loan
 * handed back in a single movement — every loan there was before instalments, and every loan a
 * booking conversion produces — therefore derives byte-identically to what it always derived, so
 * no existing ledger row moves and the issue #711 pass named below still finds it.
 *
 * Also read by the merge engine (`features/sync/merge.ts`), which precomputes a returned loan's
 * key so the issue #711 split-stock pass can find that return's ledger rows without hashing inside
 * its own synchronous pass. It derives at watermark 0, which is exact for the loans that pass can
 * apply to: it is scoped to loans carrying a `stock_operation_key`, and only a booking conversion
 * sets one — a single unit of a serialised asset, which has no instalments to return in.
 */
export function checkInId(kind: string, checkoutId: string, fromReturned = 0): Promise<string> {
  const key = fromReturned === 0 ? `${kind}:${checkoutId}` : `${kind}:${checkoutId}@${fromReturned}`;
  return uuidv5(key, CHECKOUT_RETURN_NAMESPACE);
}

/**
 * The default `CHECKED_IN` ledger note for a return of `returned` out of a loan of `quantity`.
 *
 * A return that hands the whole loan back in one movement keeps the sentence it has always had,
 * so nothing that reads the ledger sees a loan's wording change because instalments became
 * possible. An instalment says how much of the loan it was, because "Returned 2 from loan" over a
 * loan of six is the number without the fact that four are still out.
 */
function returnNote(returned: number, quantity: number, closesLoan: boolean): string {
  // Handing the whole loan over in one movement necessarily closes it, so this is the
  // pre-instalment sentence and the pre-instalment case, unchanged.
  if (returned === quantity) return `Returned ${returned} from loan.`;
  return closesLoan
    ? `Returned the last ${returned} of ${quantity} from loan.`
    : `Returned ${returned} of ${quantity} from loan.`;
}

/** The `checkouts` column holding the borrower id for a target type (the XOR triple). */
export function borrowerColumn(type: BorrowerType): 'contact_id' | 'project_id' | 'location_id' {
  return type === 'contact' ? 'contact_id' : type === 'project' ? 'project_id' : 'location_id';
}

/**
 * The optional extras a return can carry — structurally identical to `CheckInOptions`.
 *
 * `condition` is deliberately **not** widened to include `null`: an omitted condition
 * (`undefined`) leaves the item untouched, whereas a `null` would read as "changed to no
 * condition" and emit `UPDATE items SET condition = NULL` plus a `CONDITION_CHANGED` entry
 * naming a condition that does not exist. Only `undefined` means "don't touch".
 */
export interface CheckInPlanOptions {
  readonly note?: string;
  readonly condition?: Condition;
  /**
   * How many units are coming back **this time** (issue #662). Omitted returns everything still
   * out, which is the whole loan for a loan nothing has come back from — so an unqualified
   * `planCheckIn` behaves exactly as it always did.
   *
   * A value below the outstanding quantity is a *partial* return: those units are restored to the
   * source lot, `returned_quantity` accumulates, and the loan stays **open** with the rest still
   * out. Must be at least 1 and at most the outstanding quantity; anything else throws rather
   * than silently clamping, because a caller asking to return more than is out has miscounted and
   * clamping would hide it.
   */
  readonly quantity?: number;
}

/**
 * The user-facing sentence for a return that lost a race against another partial return of the
 * same loan (see {@link OPEN_LOAN_AT_WATERMARK}). An authored sentence under a constraint code is
 * kept verbatim by the error-copy seam (issue #311), exactly as `PO_RECEIPT_RACE_MESSAGE` is.
 */
export const LOAN_RETURN_RACE_MESSAGE =
  'This loan changed while the return was being saved. Check how many are still out and try again.';

/**
 * True when the compare-and-swap sentinel {@link planCheckIn}'s closing `UPDATE` writes tripped
 * the `returned_quantity >= 0` CHECK. Keyed on the message rather than the code for the reason
 * `isReceivedQtyGuardViolation` documents: the three drivers report the same failure under
 * different codes, so a code set would silently miss in the browser.
 */
export function isReturnedQuantityGuardViolation(error: unknown): boolean {
  if (!(error instanceof DbError)) return false;
  return /CHECK constraint failed:\s*returned_quantity >= 0/i.test(error.message);
}

/**
 * The correlated predicate that is true only while a checkout is still **open** — the database
 * backstop for the check-in race (issue #296).
 *
 * `checkIn` reads the row and decides to return it (the JS `returned_at IS NULL` guard above),
 * then writes in a *separate* transaction the worker never pairs with that read. Two overlapping
 * returns for the same loan therefore both observe `returned_at === null` and, without this, both
 * restore stock and both log `CHECKED_IN` for one physical return. Carrying this guard on every
 * write statement — and stamping `returned_at` **last** so the guards still see it NULL — collapses
 * the loser to a pure no-op at the database, not merely in JavaScript.
 *
 * Since issue #662 the loan is no longer closed by every return, so "still open" is no longer the
 * whole story: two overlapping *partial* returns both leave the loan open, and a guard that only
 * asked `returned_at IS NULL` would let both restore their units against one outstanding figure.
 * So the predicate is a compare-and-swap on the return watermark as well — the loan is open **and**
 * `returned_quantity` still holds the value this plan was built from. Binds the checkout id and
 * that watermark, in that order.
 */
const OPEN_LOAN_AT_WATERMARK =
  'EXISTS (SELECT 1 FROM checkouts WHERE id = ? AND returned_at IS NULL AND returned_quantity = ?)';

/**
 * Rewrite a builder's `INSERT … VALUES (…)` into
 * `INSERT … SELECT … WHERE {@link OPEN_LOAN_AT_WATERMARK}`, so the row is inserted only while the
 * loan is still open *and* has returned no more than this plan read (issues #296, #662). A `SELECT`
 * that matches no rows inserts nothing — and never reaches any trailing `ON CONFLICT` upsert — so a
 * raced return's stock restore and ledger entry both vanish.
 *
 * Relies on the builder emitting a single `VALUES (…)` tuple whose bound values contain no `)` —
 * true of {@link historyStatement} and {@link addBatchStatement}, whose bindings are all `?`
 * placeholders. Throws if that shape ever changes rather than silently emitting an unguarded write
 * that would re-open the race.
 */
function onlyWhileOpen(base: SqlStatement, checkoutId: string, fromReturned: number): SqlStatement {
  const sql = base.sql.replace(/VALUES\s*\(([^)]*)\)/, `SELECT $1 WHERE ${OPEN_LOAN_AT_WATERMARK}`);
  if (sql === base.sql) {
    throw new DbError('UNKNOWN', 'Cannot guard a check-in write: expected a VALUES clause to rewrite.');
  }
  const params = Array.isArray(base.params) ? base.params : [];
  return { sql, params: [...params, checkoutId, fromReturned] };
}

/**
 * Plan a single loan's return: read the checkout and its item, then build the statements that
 * restore the stock, close the loan and log it. Returns an **empty** list when the loan has
 * already been returned (the idempotent no-op {@link CheckoutRepository.checkIn} relies on).
 *
 * Every write is guarded by {@link OPEN_LOAN_EXISTS} and the `returned_at` stamp is emitted last,
 * so two returns that race past the JS guard (both reading `returned_at IS NULL`) still restore
 * stock and log `CHECKED_IN` exactly once — the loser's whole transaction no-ops (issue #296).
 *
 * Throws when the checkout does not exist — the caller asked to return something that isn't there.
 */
export async function planCheckIn(
  driver: IDatabaseDriver,
  checkoutId: string,
  actorId: string,
  options: CheckInPlanOptions = {},
): Promise<SqlStatement[]> {
  const { note, condition } = options;
  const existing = await driver.queryOne<CheckoutRow>('SELECT * FROM checkouts WHERE id = ?;', [checkoutId]);
  if (!existing) {
    throw new DbError('SQLITE_CONSTRAINT', `Checkout "${checkoutId}" does not exist.`);
  }
  if (existing.returned_at !== null) return []; // already returned — idempotent

  // How much of the loan is still out, and how much of *that* is coming back now (issue #662).
  // An omitted quantity returns everything outstanding, so an unqualified return of an untouched
  // loan is the whole loan in one movement — the only shape that existed before partial returns.
  const fromReturned = existing.returned_quantity;
  const outstanding = existing.quantity - fromReturned;
  const returnQuantity = options.quantity ?? outstanding;
  if (!Number.isInteger(returnQuantity) || returnQuantity < 1 || returnQuantity > outstanding) {
    throw new DbError(
      'SQLITE_CONSTRAINT',
      `Cannot return ${returnQuantity} — this loan has ${outstanding} still out.`,
    );
  }
  // The loan closes only when the last outstanding unit comes back. Until then `returned_at`
  // stays NULL, so the derived OPEN status, the overdue predicates and the sync model all keep
  // reading a partially-returned loan as exactly what it is: still out.
  const closesLoan = returnQuantity === outstanding;

  const item = await driver.queryOne<{
    location_id: string;
    tracking_mode: string;
    condition: string | null;
  }>('SELECT location_id, tracking_mode, condition FROM items WHERE id = ?;', [existing.item_id]);
  // SERIALISED stock was never decremented (it is pinned to 1), so it is not restored.
  // The loan is returned to *where it was lent from* (Phase 26): the stored source
  // placement, or the item's current primary location when no source was recorded (or
  // it was nulled because that location has since been deleted). And to *the exact lot* it
  // came from (Phase 29): the canonical `source_batch_key` round-trips back to its identity
  // via `batchIdentityFromKey`, so a tracked lot is rebuilt rather than anonymised into the
  // untracked default (NULL/'' → the default batch — the pre-Phase-29 behaviour). `addBatch`
  // upserts, so the lot is recreated even if it was emptied/consolidated while the unit was out.
  const restoreDelta = item?.tracking_mode === 'SERIALISED' ? 0 : returnQuantity;
  const restoreLocationId = existing.source_location_id ?? item?.location_id;
  const restoreIdentity = existing.source_batch_key
    ? batchIdentityFromKey(existing.source_batch_key)
    : UNTRACKED_BATCH;

  // Condition on return (B2): only when a condition was supplied *and* it differs from the
  // item's current one do we record a change — mirroring `ItemRepository.update`'s guard so a
  // return that re-affirms the same condition logs no spurious `CONDITION_CHANGED`. Leaving it
  // unset (undefined) never touches the item, keeping the empty submit a pure one-tap return.
  const currentCondition = item?.condition ?? null;
  const conditionChanged = condition !== undefined && condition !== currentCondition;

  const statements: SqlStatement[] = [
    // Restore the stock lot — guarded, so a raced return does not restore it a second time.
    ...(restoreDelta > 0 && restoreLocationId
      ? [
          onlyWhileOpen(
            addBatchStatement(existing.item_id, restoreLocationId, restoreIdentity, restoreDelta),
            checkoutId,
            fromReturned,
          ),
        ]
      : []),
    // Log CHECKED_IN — guarded, so a raced return does not write a duplicate ledger entry.
    onlyWhileOpen(
      historyStatement(existing.item_id, 'CHECKED_IN', actorId, {
        // Derived like the stock it restores (see {@link CHECKOUT_RETURN_NAMESPACE}), so two
        // devices returning the same loan leave one entry in the union-by-id ledger, not two.
        // The watermark qualifies the derivation from the second instalment on, so a loan
        // returned in stages does not collapse its stages into one entry — while a loan
        // returned in one movement keeps the very id it derived before issue #662.
        id: await checkInId('hist:CHECKED_IN', checkoutId, fromReturned),
        quantityDelta: restoreDelta === 0 ? null : restoreDelta,
        note: note?.trim() || returnNote(returnQuantity, existing.quantity, closesLoan),
        metadata: { checkoutId },
      }),
      checkoutId,
      fromReturned,
    ),
    // The condition change rides in the same transaction as the return + stock restore, so a
    // returned tool's new state is atomic with its check-in. `updated_at` self-stamps via the
    // items trigger (the UPDATE leaves it untouched), exactly as `ItemRepository.update` relies on.
    // Both statements carry the open-loan guard so a raced return neither re-applies the condition
    // nor logs a duplicate CONDITION_CHANGED.
    ...(conditionChanged
      ? [
          {
            sql: `UPDATE items SET condition = ? WHERE id = ? AND ${OPEN_LOAN_AT_WATERMARK};`,
            params: [condition, existing.item_id, checkoutId, fromReturned] as SqlValue[],
          },
          onlyWhileOpen(
            historyStatement(existing.item_id, 'CONDITION_CHANGED', actorId, {
              note: `Condition changed ${currentCondition ? `from "${currentCondition}" ` : ''}to "${condition}" on return.`,
              metadata: { from: currentCondition, to: condition, checkoutId },
            }),
            checkoutId,
            fromReturned,
          ),
        ]
      : []),
    // Advance the return watermark LAST, so every guard above still sees the loan open at the
    // value this plan read. Two things happen in one statement because they are one fact: the
    // units are accounted for, and the loan closes if that was the last of them.
    //
    // `WHERE … returned_at IS NULL` is the structural backstop from issue #296: once another
    // return has *closed* the loan this UPDATE — like the guarded writes before it — matches no
    // row and modifies nothing, so an overlapping full return still collapses to a silent no-op.
    //
    // A return that lost the race to another **partial** one is different, and must not be
    // silent: the loan is still open, so the row still matches, and writing the plan's units
    // onto a watermark that has moved would restore against an outstanding figure that no longer
    // exists. The compare-and-swap writes the sentinel -1 instead, tripping the column's
    // `returned_quantity >= 0` CHECK and rolling the whole return back — the stock, the ledger
    // entry and any condition change with it. `CheckoutRepository.checkIn` turns that abort into
    // {@link LOAN_RETURN_RACE_MESSAGE}. This is `receivedQtyDeltaStatement`'s guard (issue #298),
    // which solves the same problem for a purchase-order line's cumulative `received_qty`.
    //
    // The return note lands in its OWN column — never `note`, which holds the reason the
    // item was lent out. Writing it here (not `note = COALESCE(?, note)`) means a return
    // remark no longer clobbers the loan note; both survive independently. An instalment's
    // remark is kept only by the return that closes the loan, which is the one the column
    // describes; a partial return's remark lives in its `CHECKED_IN` ledger entry.
    {
      sql: `UPDATE checkouts
               SET returned_quantity = CASE WHEN returned_quantity = ? THEN returned_quantity + ? ELSE -1 END
                   ${closesLoan ? `, returned_at = (${SQL_NOW_MS}), return_note = ?` : ''}
             WHERE id = ? AND returned_at IS NULL;`,
      params: closesLoan
        ? [fromReturned, returnQuantity, note?.trim() || null, checkoutId]
        : [fromReturned, returnQuantity, checkoutId],
    },
  ];

  // Bracket the return so the `stock_batches` capture trigger derives its `stock_deltas` id from
  // the loan rather than at random — without it, two devices returning the same loan offline give
  // the units back twice (see {@link CHECKOUT_RETURN_NAMESPACE}). Each loan gets its own key, so a
  // borrower-wide return concatenates one bracket per loan rather than sharing one across all of
  // them, and no loan's id depends on how many others happened to be returned beside it. Each
  // *instalment* gets its own key too, via the watermark it started from, so a loan handed back in
  // stages does not give the union one key for several distinct movements.
  //
  // `CONDITION_CHANGED` above is deliberately left random: unlike the return itself, two devices
  // can record genuinely *different* conditions on the way back, and one derived id would keep
  // only whichever arrived first while the item's own `condition` settles by last-write-wins.
  return withOperationKey(await checkInId('stock', checkoutId, fromReturned), statements);
}

/**
 * Plan the return of **every** still-open loan borrowed by a target (contact, project or
 * location) — the statements a borrower delete must run before the row goes away, so its
 * active loans never strand stock marked "out". Deliberately unbounded: every open loan is
 * returned, not just the first page.
 *
 * Each loan is planned against the pre-transaction state, which is safe because the plans only
 * ever *add* stock back: `addBatchStatement` upserts with `quantity = quantity + excluded`, so
 * two loans of the same lot accumulate rather than clobber, and each loan's `returned_at`
 * UPDATE targets its own row. The same holds for the issue #662 watermark each plan
 * compare-and-swaps: no two loans in this batch share a `checkouts` row, so no plan's read of
 * `returned_quantity` can be invalidated by another plan beside it.
 */
export async function planCheckInAllForTarget(
  driver: IDatabaseDriver,
  type: BorrowerType,
  id: string,
  actorId: string,
): Promise<SqlStatement[]> {
  const open = await driver.query<{ id: string }>(
    `SELECT id FROM checkouts WHERE ${borrowerColumn(type)} = ? AND returned_at IS NULL;`,
    [id],
  );
  const statements: SqlStatement[] = [];
  for (const row of open) {
    statements.push(...(await planCheckIn(driver, row.id, actorId)));
  }
  return statements;
}
