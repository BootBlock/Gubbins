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
import { addBatchStatement, UNTRACKED_BATCH } from './stock-batches';
import { batchIdentityFromKey } from '@/features/inventory/batches';
import type { CheckoutRow } from './types';

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
}

/**
 * Plan a single loan's return: read the checkout and its item, then build the statements that
 * restore the stock, close the loan and log it. Returns an **empty** list when the loan has
 * already been returned (the idempotent no-op {@link CheckoutRepository.checkIn} relies on).
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
  const restoreDelta = item?.tracking_mode === 'SERIALISED' ? 0 : existing.quantity;
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

  return [
    ...(restoreDelta > 0 && restoreLocationId
      ? [addBatchStatement(existing.item_id, restoreLocationId, restoreIdentity, restoreDelta)]
      : []),
    {
      // The return note lands in its OWN column — never `note`, which holds the reason the
      // item was lent out. Writing it here (not `note = COALESCE(?, note)`) means a return
      // remark no longer clobbers the loan note; both survive independently.
      sql: `UPDATE checkouts SET returned_at = (${SQL_NOW_MS}), return_note = ? WHERE id = ?;`,
      params: [note?.trim() || null, checkoutId],
    },
    historyStatement(existing.item_id, 'CHECKED_IN', actorId, {
      quantityDelta: restoreDelta === 0 ? null : restoreDelta,
      note: note?.trim() || `Returned ${existing.quantity} from loan.`,
      metadata: { checkoutId },
    }),
    // The condition change rides in the same transaction as the return + stock restore, so a
    // returned tool's new state is atomic with its check-in. `updated_at` self-stamps via the
    // items trigger (the UPDATE leaves it untouched), exactly as `ItemRepository.update` relies on.
    ...(conditionChanged
      ? [
          {
            sql: `UPDATE items SET condition = ? WHERE id = ?;`,
            params: [condition, existing.item_id] as SqlValue[],
          },
          historyStatement(existing.item_id, 'CONDITION_CHANGED', actorId, {
            note: `Condition changed ${currentCondition ? `from "${currentCondition}" ` : ''}to "${condition}" on return.`,
            metadata: { from: currentCondition, to: condition, checkoutId },
          }),
        ]
      : []),
  ];
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
 * UPDATE targets its own row.
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
