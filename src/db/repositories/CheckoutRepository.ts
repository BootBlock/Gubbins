/**
 * CheckoutRepository (spec §2.1.1, §4 "Borrowing & Checking Out", Phase 6).
 *
 * Encapsulates the borrow lifecycle. Checking an item out to a contact decrements
 * its on-hand quantity (the units have physically left the building — unlike a
 * Phase-4 reservation, which is only a ledger annotation), records a `checkouts`
 * row, and logs `CHECKED_OUT` to the Activity Ledger, all atomically. Checking it
 * back in stamps `returned_at`, restores the quantity, and logs `CHECKED_IN`.
 *
 * A checkout's OPEN/RETURNED status is *derived* from the nullable `returned_at`
 * column (no stored enum), keeping the §7.1 LWW model a simple last-write-wins.
 * Contacts are resolved low-friction via the injected {@link ContactRepository}:
 * a typed name auto-creates a contact (§4 Ergonomics). Checkouts grow storage and
 * are Hard-Stop gated; check-ins (which can only shrink the open set) are not.
 */
import { DbError } from '../errors';
import { SQL_NOW_MS } from '../migrations';
import type { IDatabaseDriver, SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository, type RepositoryOptions } from './base';
import type { BorrowerType, CheckoutStatus, Condition } from './constants';
import { ContactRepository } from './ContactRepository';
import { stockRowId } from './stock';
import {
  addBatchStatement,
  consumeBatchStatements,
  placementDeltaStatements,
  readPlacementBatches,
  stockBatchRowId,
  UNTRACKED_BATCH,
} from './stock-batches';
import { batchIdentityFromKey, planBatchSelection } from '@/features/inventory/batches';
import { rowToCheckout } from './mappers';
import type {
  CheckoutBorrower,
  CheckoutItemInput,
  Checkout,
  CheckoutRow,
  CheckoutWithNames,
  Page,
  PageParams,
} from './types';

interface CheckoutJoinRow extends CheckoutRow {
  readonly item_name: string;
  /** The borrower's display name, resolved per target type via the LEFT JOINs (B4). */
  readonly borrower_name: string;
}

/**
 * A correlated `EXISTS` predicate that is true for an item with at least one **open**
 * checkout whose due date has passed — the SQL counterpart of the derived `isOverdue` flag
 * on {@link CheckoutWithNames} (`OPEN && dueDate !== null && dueDate < now`). Shared so the
 * inventory list's "Overdue" status filter reuses the same definition. It correlates against
 * the outer `items` table by `items.id`, so embed it in a `WHERE` over `FROM items`.
 *
 * Binds `now` (UNIX-ms) **once**.
 */
export function overdueCheckoutExistsSql(): string {
  return `EXISTS (
    SELECT 1 FROM checkouts k
    WHERE k.item_id = items.id
      AND k.returned_at IS NULL
      AND k.due_date IS NOT NULL
      AND k.due_date < ?
  )`;
}

/**
 * A correlated `EXISTS` predicate that is true for an item with at least one **open**
 * checkout — i.e. currently on loan (out with a contact), whether or not it is overdue. The
 * OPEN status is derived from a null `returned_at`, exactly as {@link CheckoutStatus} is. It
 * correlates against the outer `items` table by `items.id`, so embed it in a `WHERE` over
 * `FROM items`. Takes no bound parameters.
 */
export function onLoanCheckoutExistsSql(): string {
  return `EXISTS (
    SELECT 1 FROM checkouts k
    WHERE k.item_id = items.id
      AND k.returned_at IS NULL
  )`;
}

/**
 * Optional facets captured when a loan is returned (§4 Borrowing).
 *
 * A single options object rather than positional args so the return flow can grow more
 * captured state (condition, note, and future recount/maintenance flags) without churning
 * the signature at every call site. Both fields are optional — `checkIn(id)` with no options
 * is the fast one-tap return.
 */
export interface CheckInOptions {
  /** Free-text return remark; stored in the checkout's own `return_note` column (B1). */
  readonly note?: string;
  /**
   * The item's condition *on return* (B2). When supplied and different from the item's current
   * condition, updates `items.condition` and logs `CONDITION_CHANGED` in the same transaction.
   * Omitted leaves the condition untouched.
   */
  readonly condition?: Condition;
}

export class CheckoutRepository extends BaseRepository {
  private readonly contacts: ContactRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.contacts = new ContactRepository(driver, options);
  }

  async getById(id: string): Promise<Checkout | undefined> {
    const row = await this.driver.queryOne<CheckoutRow>('SELECT * FROM checkouts WHERE id = ?;', [id]);
    return row ? rowToCheckout(row) : undefined;
  }

  /**
   * Check `quantity` units of an item out to a contact (§4). The contact is given
   * by id, or by a raw name that is resolved-or-created on the fly. On-hand stock
   * is decremented; gauge items cannot be borrowed as discrete units.
   */
  async checkout(input: CheckoutItemInput): Promise<Checkout> {
    this.assertWritable();

    const item = await this.driver.queryOne<{
      tracking_mode: string;
      location_id: string;
      is_active: number;
      is_unlimited: number;
    }>('SELECT tracking_mode, is_active, location_id, is_unlimited FROM items WHERE id = ?;', [input.itemId]);
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${input.itemId}" does not exist.`);
    }
    if (item.tracking_mode === 'CONSUMABLE_GAUGE') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Consumable-gauge items are tracked by remaining material, not borrowed — check out a discrete item instead.',
      );
    }
    if (item.tracking_mode === 'UNTRACKED') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Untracked items carry no countable stock to lend — use a serialised item for assets that are checked out.',
      );
    }
    if (item.is_unlimited === 1) {
      // An infinite source (tap water, mains air) is not "lent" — mirror the UNTRACKED guard (Phase 82).
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Unlimited-supply items are an infinite source, not a lendable asset — they cannot be checked out.',
      );
    }

    const requested = input.quantity ?? 1;
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'Checkout quantity must be a positive whole number.');
    }

    // SERIALISED items are pinned to quantity 1 by a CHECK constraint, so a loan
    // cannot decrement their stock; instead one unit goes out as a whole and we
    // guard against double-borrowing it. DISCRETE loans decrement on-hand stock.
    const isSerialised = item.tracking_mode === 'SERIALISED';
    const quantity = isSerialised ? 1 : requested;

    // Per-location source (Phase 26): a DISCRETE loan may be drawn from a *specific*
    // placement; the return restores there. SERIALISED instances are single-placement, so
    // the source is simply the item's location. Validate against — and decrement — the
    // chosen placement's on-hand, not the primary's.
    const fromLocationId = !isSerialised && input.fromLocationId ? input.fromLocationId : item.location_id;

    // Per-batch source (Phase 29): a DISCRETE loan may pick a *specific* lot at the placement
    // (the empty string = the untracked default batch); the return restores to that exact lot.
    // Omitted = the Phase-28 FEFO draw. SERIALISED instances have no batch dimension.
    const fromBatchKey = !isSerialised && input.fromBatchKey !== undefined ? input.fromBatchKey : null;

    if (isSerialised) {
      const open = await this.driver.queryOne<{ ok: number }>(
        'SELECT 1 AS ok FROM checkouts WHERE item_id = ? AND returned_at IS NULL LIMIT 1;',
        [input.itemId],
      );
      if (open) {
        throw new DbError('SQLITE_CONSTRAINT', 'This serialised item is already checked out.');
      }
    } else if (fromBatchKey !== null) {
      // Validate against — and later draw down — *the chosen lot's* own quantity.
      const lot = await this.driver.queryOne<{ quantity: number }>(
        'SELECT quantity FROM stock_batches WHERE id = ?;',
        [stockBatchRowId(input.itemId, fromLocationId, fromBatchKey)],
      );
      const available = Number(lot?.quantity ?? 0);
      if (available < quantity) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough of the chosen lot to check out: ${available} on hand, ${quantity} requested.`,
        );
      }
    } else {
      const placement = await this.driver.queryOne<{ quantity: number }>(
        'SELECT quantity FROM item_stock WHERE id = ?;',
        [stockRowId(input.itemId, fromLocationId)],
      );
      const available = Number(placement?.quantity ?? 0);
      if (available < quantity) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough stock at the chosen location to check out: ${available} on hand, ${quantity} requested.`,
        );
      }
    }

    const borrower = await this.resolveBorrower(input);
    const id = crypto.randomUUID();
    const stockDelta = isSerialised ? 0 : quantity;
    const dueDate = input.dueDate ?? null;

    // The loan draws down the source placement: from the *chosen lot* when one was picked
    // (Phase 29), else first-expiry-first-out across the placement's batches (Phase 28).
    // Availability was validated above, so the plan has no shortfall either way.
    let stockStatements: SqlStatement[] = [];
    if (stockDelta > 0) {
      stockStatements =
        fromBatchKey !== null
          ? consumeBatchStatements(
              input.itemId,
              fromLocationId,
              planBatchSelection(
                await readPlacementBatches(this.driver, input.itemId, fromLocationId),
                fromBatchKey,
                stockDelta,
              ),
            )
          : await placementDeltaStatements(this.driver, input.itemId, fromLocationId, -stockDelta);
    }

    await this.driver.transaction([
      ...stockStatements,
      {
        // The borrower lands in exactly one of the three FK columns per its target type; the
        // other two stay NULL (the XOR CHECK enforces this). `borrowerColumn` picks the column.
        sql: `INSERT INTO checkouts (id, item_id, ${borrowerColumn(borrower.type)}, quantity, due_date, note, source_location_id, source_batch_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        params: [
          id,
          input.itemId,
          borrower.id,
          quantity,
          dueDate,
          input.note?.trim() || null,
          fromLocationId,
          fromBatchKey,
        ],
      },
      historyStatement(input.itemId, 'CHECKED_OUT', {
        quantityDelta: stockDelta === 0 ? null : -stockDelta,
        note: `Checked out ${quantity} to ${borrower.name}${dueDate ? ' (due set)' : ''}.`,
        metadata: {
          checkoutId: id,
          borrowerType: borrower.type,
          borrowerId: borrower.id,
          quantity,
          dueDate,
          fromLocationId,
          fromBatchKey,
        },
      }),
    ]);
    return (await this.getById(id))!;
  }

  /**
   * Return an open checkout: restore stock, stamp `returned_at`, log `CHECKED_IN`.
   *
   * Optional `note` records a free-text return remark in the checkout's own `return_note`
   * column (never the loan note — see B1). Optional `condition` captures the item's state
   * *on return* (B2): when supplied and different from the item's current condition, it
   * updates `items.condition` and logs a `CONDITION_CHANGED` row in the same transaction —
   * a returned tool is frequently in a different state (blunt, chipped, now due calibration).
   * Leaving `condition` unset never touches the item, preserving the fast one-tap return.
   */
  async checkIn(checkoutId: string, options: CheckInOptions = {}): Promise<Checkout> {
    const { note, condition } = options;
    const existing = await this.driver.queryOne<CheckoutRow>('SELECT * FROM checkouts WHERE id = ?;', [
      checkoutId,
    ]);
    if (!existing) {
      throw new DbError('SQLITE_CONSTRAINT', `Checkout "${checkoutId}" does not exist.`);
    }
    if (existing.returned_at !== null) {
      return rowToCheckout(existing); // already returned — idempotent
    }

    const item = await this.driver.queryOne<{
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

    await this.driver.transaction([
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
      historyStatement(existing.item_id, 'CHECKED_IN', {
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
            historyStatement(existing.item_id, 'CONDITION_CHANGED', {
              note: `Condition changed ${currentCondition ? `from "${currentCondition}" ` : ''}to "${condition}" on return.`,
              metadata: { from: currentCondition, to: condition, checkoutId },
            }),
          ]
        : []),
    ]);
    return (await this.getById(checkoutId))!;
  }

  /**
   * Renew an open loan by changing its due date **in place** (B3).
   *
   * To move a loan's due date users previously had to check the item in and back out again —
   * losing the loan's continuity and its original checkout timestamp. This updates `due_date`
   * on the *open* checkout directly and logs a `LOAN_RENEWED` row (old → new date in the note
   * and metadata), leaving `checked_out_at` and the original loan `note` untouched — that
   * continuity is the whole point. No stock moves; the item is not touched.
   *
   * `dueDate` accepts `null` — clearing a due date is a valid renew, turning a dated loan into
   * an open-ended one. Unlike {@link checkIn} (which no-ops idempotently on an already-returned
   * row), renewing a *closed* loan is a genuinely invalid request, so it throws: there is no
   * open loan to extend.
   */
  async renew(checkoutId: string, options: { dueDate: number | null }): Promise<Checkout> {
    const existing = await this.driver.queryOne<CheckoutRow>('SELECT * FROM checkouts WHERE id = ?;', [
      checkoutId,
    ]);
    if (!existing) {
      throw new DbError('SQLITE_CONSTRAINT', `Checkout "${checkoutId}" does not exist.`);
    }
    if (existing.returned_at !== null) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'This loan has already been returned — there is nothing to renew.',
      );
    }

    const newDueDate = options.dueDate ?? null;
    const oldDueDate = existing.due_date;

    await this.driver.transaction([
      {
        // Only `due_date` changes — `checked_out_at` and the loan `note` are deliberately left
        // alone so the loan keeps its identity and history across a renewal.
        sql: `UPDATE checkouts SET due_date = ? WHERE id = ?;`,
        params: [newDueDate, checkoutId],
      },
      historyStatement(existing.item_id, 'LOAN_RENEWED', {
        note: renewNote(oldDueDate, newDueDate),
        metadata: { checkoutId, from: oldDueDate, to: newDueDate },
      }),
    ]);
    return (await this.getById(checkoutId))!;
  }

  /**
   * Return every still-open checkout borrowed by a target (contact, project or location),
   * exactly as an ordinary check-in would (restoring stock to its source placement/lot and
   * logging `CHECKED_IN`) — used before a borrower is deleted so its active loans never strand
   * stock. The target's `ON DELETE CASCADE` then removes the (now-returned) rows. Deliberately
   * unbounded: every open loan must be returned, not just the first page.
   */
  async checkInAllForTarget(type: BorrowerType, id: string): Promise<void> {
    const open = await this.driver.query<{ id: string }>(
      `SELECT id FROM checkouts WHERE ${borrowerColumn(type)} = ? AND returned_at IS NULL;`,
      [id],
    );
    for (const row of open) {
      await this.checkIn(row.id);
    }
  }

  /**
   * Return every still-open checkout for a contact (a {@link checkInAllForTarget} shorthand
   * for the `contact` target — the contact-delete cascade helper).
   */
  async checkInAllForContact(contactId: string): Promise<void> {
    await this.checkInAllForTarget('contact', contactId);
  }

  /** All open (still-out) checkouts, soonest due first, with item + contact names. */
  async listOpen(params: PageParams = {}): Promise<Page<CheckoutWithNames>> {
    return this.listJoined('WHERE k.returned_at IS NULL', [], params, 'k.due_date IS NULL, k.due_date ASC');
  }

  /** A single item's checkout history (open first, then newest), bounded. */
  async listForItem(itemId: string, params: PageParams = {}): Promise<Page<CheckoutWithNames>> {
    return this.listJoined(
      'WHERE k.item_id = ?',
      [itemId],
      params,
      'k.returned_at IS NULL DESC, k.checked_out_at DESC',
    );
  }

  /** A single contact's checkout history (open first, then newest), bounded. */
  async listForContact(contactId: string, params: PageParams = {}): Promise<Page<CheckoutWithNames>> {
    return this.listForBorrower('contact', contactId, params);
  }

  /** A single project's checkout history (open first, then newest), bounded (B4). */
  async listForProject(projectId: string, params: PageParams = {}): Promise<Page<CheckoutWithNames>> {
    return this.listForBorrower('project', projectId, params);
  }

  /** A single location's checkout history (open first, then newest), bounded (B4). */
  async listForLocation(locationId: string, params: PageParams = {}): Promise<Page<CheckoutWithNames>> {
    return this.listForBorrower('location', locationId, params);
  }

  // --- internals -----------------------------------------------------------------

  /** A single borrower's checkout history, keyed by its target column (B4). */
  private listForBorrower(
    type: BorrowerType,
    id: string,
    params: PageParams,
  ): Promise<Page<CheckoutWithNames>> {
    return this.listJoined(
      `WHERE k.${borrowerColumn(type)} = ?`,
      [id],
      params,
      'k.returned_at IS NULL DESC, k.checked_out_at DESC',
    );
  }

  /**
   * Resolve the loan's borrower (B4) from the discriminated input: exactly one of a contact
   * (by id or auto-created name), a project id, or a location id. Zero or multiple targets is
   * an error (the DB's XOR CHECK would reject it anyway, but a clear message beats a constraint
   * failure). A contact keeps the low-friction resolve-or-create-by-name convenience; project
   * and location must reference an existing row (never created here).
   */
  private async resolveBorrower(input: CheckoutItemInput): Promise<CheckoutBorrower> {
    const hasContact = Boolean(input.contactId) || Boolean(input.contactName?.trim());
    const provided = [hasContact, Boolean(input.projectId), Boolean(input.locationId)].filter(Boolean).length;
    if (provided === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A checkout needs a borrower (a contact, project or location).');
    }
    if (provided > 1) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'A loan can go to only one borrower — pick a contact, a project or a location, not several.',
      );
    }

    if (input.projectId) {
      const project = await this.driver.queryOne<{ name: string }>(
        'SELECT name FROM projects WHERE id = ?;',
        [input.projectId],
      );
      if (!project) {
        throw new DbError('SQLITE_CONSTRAINT', `Project "${input.projectId}" does not exist.`);
      }
      return { type: 'project', id: input.projectId, name: project.name };
    }
    if (input.locationId) {
      const location = await this.driver.queryOne<{ name: string }>(
        'SELECT name FROM locations WHERE id = ?;',
        [input.locationId],
      );
      if (!location) {
        throw new DbError('SQLITE_CONSTRAINT', `Location "${input.locationId}" does not exist.`);
      }
      return { type: 'location', id: input.locationId, name: location.name };
    }

    if (input.contactId) {
      const contact = await this.contacts.getById(input.contactId);
      if (!contact) {
        throw new DbError('SQLITE_CONSTRAINT', `Contact "${input.contactId}" does not exist.`);
      }
      return { type: 'contact', id: contact.id, name: contact.name };
    }
    const contact = await this.contacts.resolveOrCreate(input.contactName!.trim());
    return { type: 'contact', id: contact.id, name: contact.name };
  }

  private async listJoined(
    where: string,
    whereParams: SqlValue[],
    params: PageParams,
    orderBy: string,
  ): Promise<Page<CheckoutWithNames>> {
    const { limit, offset } = this.resolvePage(params);
    // The borrower is a tagged union (B4): LEFT JOIN all three target tables and COALESCE the
    // name — exactly one FK is set per the XOR CHECK, so exactly one join contributes a name.
    const rows = await this.driver.query<CheckoutJoinRow>(
      `SELECT k.*, i.name AS item_name,
              COALESCE(c.name, p.name, l.name) AS borrower_name
       FROM checkouts k
       JOIN items i ON i.id = k.item_id
       LEFT JOIN contacts c ON c.id = k.contact_id
       LEFT JOIN projects p ON p.id = k.project_id
       LEFT JOIN locations l ON l.id = k.location_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?;`,
      [...whereParams, limit, offset],
    );
    const now = Date.now();
    return this.toPage(
      rows.map((r) => toCheckoutWithNames(r, now)),
      limit,
      offset,
    );
  }
}

/** The `checkouts` FK column that stores a borrower of the given target type (B4). */
function borrowerColumn(type: BorrowerType): 'contact_id' | 'project_id' | 'location_id' {
  switch (type) {
    case 'project':
      return 'project_id';
    case 'location':
      return 'location_id';
    default:
      return 'contact_id';
  }
}

/** Compose a joined checkout row into the display DTO with derived status/overdue. */
function toCheckoutWithNames(row: CheckoutJoinRow, now: number): CheckoutWithNames {
  const base = rowToCheckout(row);
  const status: CheckoutStatus = base.returnedAt === null ? 'OPEN' : 'RETURNED';
  return {
    ...base,
    itemName: row.item_name,
    borrowerName: row.borrower_name,
    status,
    isOverdue: status === 'OPEN' && base.dueDate !== null && base.dueDate < now,
  };
}

/**
 * A British-English ledger note for a loan renewal (B3), describing the due-date change as
 * old → new. Dates render as `yyyy-MM-dd` (locale-independent, since the repository has no
 * formatter); a null date reads as "open-ended", covering set/clear/extend uniformly.
 */
function renewNote(from: number | null, to: number | null): string {
  const label = (ms: number | null) => (ms === null ? 'open-ended' : new Date(ms).toISOString().slice(0, 10));
  return `Loan due date changed from ${label(from)} to ${label(to)}.`;
}

interface HistoryFields {
  readonly quantityDelta?: number | null;
  readonly note?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

/** Append a row to the immutable Activity Ledger (mirrors ItemRepository's helper). */
function historyStatement(itemId: string, action: string, fields: HistoryFields = {}): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      action,
      fields.quantityDelta ?? null,
      null,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ],
  };
}
