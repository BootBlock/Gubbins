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
import type { CheckoutStatus } from './constants';
import { ContactRepository } from './ContactRepository';
import { rowToCheckout } from './mappers';
import type {
  CheckoutItemInput,
  Checkout,
  CheckoutRow,
  CheckoutWithNames,
  Page,
  PageParams,
} from './types';

interface CheckoutJoinRow extends CheckoutRow {
  readonly item_name: string;
  readonly contact_name: string;
}

export class CheckoutRepository extends BaseRepository {
  private readonly contacts: ContactRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.contacts = new ContactRepository(driver, options);
  }

  async getById(id: string): Promise<Checkout | undefined> {
    const row = await this.driver.queryOne<CheckoutRow>('SELECT * FROM checkouts WHERE id = ?;', [
      id,
    ]);
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
      quantity: number;
      is_active: number;
    }>('SELECT tracking_mode, quantity, is_active FROM items WHERE id = ?;', [input.itemId]);
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${input.itemId}" does not exist.`);
    }
    if (item.tracking_mode === 'CONSUMABLE_GAUGE') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Consumable-gauge items are tracked by remaining material, not borrowed — check out a discrete item instead.',
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
    if (isSerialised) {
      const open = await this.driver.queryOne<{ ok: number }>(
        'SELECT 1 AS ok FROM checkouts WHERE item_id = ? AND returned_at IS NULL LIMIT 1;',
        [input.itemId],
      );
      if (open) {
        throw new DbError('SQLITE_CONSTRAINT', 'This serialised item is already checked out.');
      }
    } else if (item.quantity < quantity) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Not enough stock to check out: ${item.quantity} on hand, ${quantity} requested.`,
      );
    }

    const contact = await this.resolveContact(input);
    const id = crypto.randomUUID();
    const stockDelta = isSerialised ? 0 : quantity;
    const nextQty = item.quantity - stockDelta;
    const dueDate = input.dueDate ?? null;

    await this.driver.transaction([
      { sql: 'UPDATE items SET quantity = ? WHERE id = ?;', params: [nextQty, input.itemId] },
      {
        sql: `INSERT INTO checkouts (id, item_id, contact_id, quantity, due_date, note)
              VALUES (?, ?, ?, ?, ?, ?);`,
        params: [id, input.itemId, contact.id, quantity, dueDate, input.note?.trim() || null],
      },
      historyStatement(input.itemId, 'CHECKED_OUT', {
        quantityDelta: stockDelta === 0 ? null : -stockDelta,
        note: `Checked out ${quantity} to ${contact.name}${dueDate ? ' (due set)' : ''}.`,
        metadata: { checkoutId: id, contactId: contact.id, quantity, dueDate },
      }),
    ]);
    return (await this.getById(id))!;
  }

  /** Return an open checkout: restore stock, stamp `returned_at`, log `CHECKED_IN`. */
  async checkIn(checkoutId: string, note?: string): Promise<Checkout> {
    const existing = await this.driver.queryOne<CheckoutRow>(
      'SELECT * FROM checkouts WHERE id = ?;',
      [checkoutId],
    );
    if (!existing) {
      throw new DbError('SQLITE_CONSTRAINT', `Checkout "${checkoutId}" does not exist.`);
    }
    if (existing.returned_at !== null) {
      return rowToCheckout(existing); // already returned — idempotent
    }

    const item = await this.driver.queryOne<{ quantity: number; tracking_mode: string }>(
      'SELECT quantity, tracking_mode FROM items WHERE id = ?;',
      [existing.item_id],
    );
    // SERIALISED stock was never decremented (it is pinned to 1), so it is not restored.
    const restoreDelta = item?.tracking_mode === 'SERIALISED' ? 0 : existing.quantity;
    const restored = (item?.quantity ?? 0) + restoreDelta;

    await this.driver.transaction([
      { sql: 'UPDATE items SET quantity = ? WHERE id = ?;', params: [restored, existing.item_id] },
      {
        sql: `UPDATE checkouts SET returned_at = (${SQL_NOW_MS}), note = COALESCE(?, note) WHERE id = ?;`,
        params: [note?.trim() || null, checkoutId],
      },
      historyStatement(existing.item_id, 'CHECKED_IN', {
        quantityDelta: restoreDelta === 0 ? null : restoreDelta,
        note: note?.trim() || `Returned ${existing.quantity} from loan.`,
        metadata: { checkoutId },
      }),
    ]);
    return (await this.getById(checkoutId))!;
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
    return this.listJoined(
      'WHERE k.contact_id = ?',
      [contactId],
      params,
      'k.returned_at IS NULL DESC, k.checked_out_at DESC',
    );
  }

  // --- internals -----------------------------------------------------------------

  private async resolveContact(input: CheckoutItemInput) {
    if (input.contactId) {
      const contact = await this.contacts.getById(input.contactId);
      if (!contact) {
        throw new DbError('SQLITE_CONSTRAINT', `Contact "${input.contactId}" does not exist.`);
      }
      return contact;
    }
    const name = input.contactName?.trim();
    if (!name) {
      throw new DbError('SQLITE_CONSTRAINT', 'A checkout needs a contact (id or name).');
    }
    return this.contacts.resolveOrCreate(name);
  }

  private async listJoined(
    where: string,
    whereParams: SqlValue[],
    params: PageParams,
    orderBy: string,
  ): Promise<Page<CheckoutWithNames>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<CheckoutJoinRow>(
      `SELECT k.*, i.name AS item_name, c.name AS contact_name
       FROM checkouts k
       JOIN items i ON i.id = k.item_id
       JOIN contacts c ON c.id = k.contact_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?;`,
      [...whereParams, limit, offset],
    );
    const now = Date.now();
    return this.toPage(rows.map((r) => toCheckoutWithNames(r, now)), limit, offset);
  }
}

/** Compose a joined checkout row into the display DTO with derived status/overdue. */
function toCheckoutWithNames(row: CheckoutJoinRow, now: number): CheckoutWithNames {
  const base = rowToCheckout(row);
  const status: CheckoutStatus = base.returnedAt === null ? 'OPEN' : 'RETURNED';
  return {
    ...base,
    itemName: row.item_name,
    contactName: row.contact_name,
    status,
    isOverdue: status === 'OPEN' && base.dueDate !== null && base.dueDate < now,
  };
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
