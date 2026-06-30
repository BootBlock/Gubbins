/**
 * AssetBookingRepository (spec §4 extended; Phase 78 — time-based asset booking).
 *
 * Encapsulates **calendar reservations of a single identifiable asset** for a whole-day
 * date range ("book the 3D printer Tue–Thu"). This is deliberately distinct from the §4
 * project *quantity* reservation (`project_bom_lines.reserved_qty` / `reservation_status`),
 * which is a stock annotation — a booking holds *one specific unit* for a *span of days*.
 *
 * Only a `SERIALISED` asset or a single-unit `DISCRETE` item can be booked (a calendar hold
 * only makes sense for one identifiable unit); gauges and multi-unit stock are rejected.
 * Double-booking is hard-prevented: a new booking whose whole-day range overlaps any *active*
 * (non-cancelled, non-converted) booking for the same asset is refused, via the pure
 * {@link findFirstOverlap} seam. The OPEN/CANCELLED/CONVERTED state is *derived* from two
 * nullable columns (`cancelled_at`, `converted_checkout_id`) rather than a stored enum — the
 * same last-write-wins-friendly modelling the checkout uses for its `returned_at` — so the
 * §7.1 LWW sync model stays a simple one-column write. Deletions are tombstoned (§7.2).
 *
 * Contacts are resolved low-friction via the injected {@link ContactRepository}; a
 * booking→checkout conversion is delegated to {@link CheckoutRepository} (which owns the
 * stock decrement and the serialised double-out guard) and then stamps the booking.
 */
import { DbError } from '../errors';
import { SQL_NOW_MS } from '../migrations';
import type { IDatabaseDriver, SqlValue } from '../rpc/driver';
import {
  findFirstOverlap,
  normaliseDayRange,
  startOfLocalDay,
  type OverlapCandidate,
} from '@/features/bookings/booking-overlap';
import { isBookableTrackingMode } from '@/features/bookings/booking-status';
import { BaseRepository, type RepositoryOptions } from './base';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { rowToBooking } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  AssetBooking,
  AssetBookingRow,
  AssetBookingWithNames,
  BookableAsset,
  Checkout,
  ConvertBookingInput,
  CreateBookingInput,
  Page,
  PageParams,
} from './types';

interface BookingJoinRow extends AssetBookingRow {
  readonly item_name: string;
  readonly contact_name: string | null;
}

export class AssetBookingRepository extends BaseRepository {
  private readonly contacts: ContactRepository;
  private readonly checkouts: CheckoutRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.contacts = new ContactRepository(driver, options);
    this.checkouts = new CheckoutRepository(driver, options);
  }

  async getById(id: string): Promise<AssetBooking | undefined> {
    const row = await this.driver.queryOne<AssetBookingRow>(
      'SELECT * FROM asset_bookings WHERE id = ?;',
      [id],
    );
    return row ? rowToBooking(row) : undefined;
  }

  /**
   * Reserve a bookable asset for a whole-day date range. The range is snapped to local day
   * starts; the asset must be serialised or single-unit discrete; and the range must not
   * overlap any active booking for the same asset (hard double-booking prevention).
   */
  async create(input: CreateBookingInput): Promise<AssetBooking> {
    this.assertWritable();

    const item = await this.driver.queryOne<{
      tracking_mode: string;
      quantity: number;
      is_active: number;
    }>('SELECT tracking_mode, quantity, is_active FROM items WHERE id = ?;', [input.itemId]);
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${input.itemId}" does not exist.`);
    }
    if (item.is_active !== 1) {
      throw new DbError('SQLITE_CONSTRAINT', 'A decommissioned item cannot be booked.');
    }
    if (!isBookableTrackingMode(item.tracking_mode, Number(item.quantity))) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Only a serialised or single-unit item can be booked — gauge and multi-unit stock cannot.',
      );
    }

    const { start, end } = normaliseDayRange(input.startDate, input.endDate);

    const existing = await this.activeRanges(input.itemId);
    const clash = findFirstOverlap({ start, end }, existing);
    if (clash) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'This asset is already booked for an overlapping date range.',
      );
    }

    const contactId = await this.resolveContactRef(input.contactId, input.contactName);
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO asset_bookings (id, item_id, contact_id, start_date, end_date, note)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, input.itemId, contactId, start, end, input.note?.trim() || null],
    );
    return (await this.getById(id))!;
  }

  /** Cancel a booking (stamp `cancelled_at`). Idempotent; a converted booking cannot cancel. */
  async cancel(id: string): Promise<AssetBooking> {
    this.assertWritable();
    const booking = await this.requireBooking(id);
    if (booking.cancelledAt !== null) return booking; // already cancelled — idempotent
    if (booking.convertedCheckoutId !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'A booking that was checked out cannot be cancelled.');
    }
    await this.driver.execute(
      `UPDATE asset_bookings SET cancelled_at = (${SQL_NOW_MS}) WHERE id = ?;`,
      [id],
    );
    return (await this.getById(id))!;
  }

  /**
   * Convert a booking into an active checkout: delegate the stock decrement + serialised
   * double-out guard to {@link CheckoutRepository.checkout}, then stamp the booking's
   * `converted_checkout_id`. The loan due date defaults to the booking's end day.
   *
   * Best-effort (non-atomic): the checkout is created in its own transaction, then the
   * booking is stamped in a second write. The window is tiny; if the stamp were to fail the
   * checkout still stands and a re-convert would be blocked by the serialised double-out
   * guard (a serialised asset) or simply create a second loan (multi-unit — but only
   * single-unit assets are bookable). Mirrors the Phase-76 clone "best-effort" decision.
   */
  async convertToCheckout(
    id: string,
    input: ConvertBookingInput = {},
  ): Promise<{ booking: AssetBooking; checkout: Checkout }> {
    this.assertWritable();
    const booking = await this.requireBooking(id);
    if (booking.cancelledAt !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'A cancelled booking cannot be checked out.');
    }
    if (booking.convertedCheckoutId !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'This booking has already been checked out.');
    }

    const contactId = input.contactId ?? booking.contactId ?? undefined;
    const contactName = input.contactName ?? undefined;
    if (!contactId && !contactName) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Add a contact to the booking before checking it out.',
      );
    }

    const checkout = await this.checkouts.checkout({
      itemId: booking.itemId,
      contactId,
      contactName,
      dueDate: input.dueDate ?? booking.endDate,
      note: input.note?.trim() || booking.note,
    });

    await this.driver.execute(
      'UPDATE asset_bookings SET converted_checkout_id = ? WHERE id = ?;',
      [checkout.id, id],
    );
    return { booking: (await this.getById(id))!, checkout };
  }

  /** Permanently remove a booking. Tombstoned for sync (§7.2). */
  async remove(id: string): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM asset_bookings WHERE id = ?;', params: [id] },
      tombstoneStatement('asset_bookings', id),
    ]);
  }

  /** Every booking for one asset, open (non-terminal) first then by soonest start. */
  async listForItem(itemId: string, params: PageParams = {}): Promise<Page<AssetBookingWithNames>> {
    return this.listJoined(
      'WHERE b.item_id = ?',
      [itemId],
      params,
      '(b.cancelled_at IS NULL AND b.converted_checkout_id IS NULL) DESC, b.start_date ASC',
    );
  }

  /** All bookings, open (non-terminal) first then by soonest start — the bookings screen feed. */
  async list(params: PageParams = {}): Promise<Page<AssetBookingWithNames>> {
    return this.listJoined(
      '',
      [],
      params,
      '(b.cancelled_at IS NULL AND b.converted_checkout_id IS NULL) DESC, b.start_date ASC',
    );
  }

  /**
   * Active (non-cancelled, non-converted) bookings whose window has not entirely passed —
   * the §3 "Upcoming" agenda + bookings-screen feed. `now` is injected so the start-of-today
   * cut-off is deterministic and testable; ordered by soonest start.
   */
  async listUpcoming(
    now: number,
    params: PageParams = {},
  ): Promise<Page<AssetBookingWithNames>> {
    // Keep a booking until the end of its last booked day (start-of-day + one day).
    const cutoff = startOfLocalDay(now);
    return this.listJoined(
      'WHERE b.cancelled_at IS NULL AND b.converted_checkout_id IS NULL AND b.end_date >= ?',
      [cutoff],
      params,
      'b.start_date ASC',
    );
  }

  /**
   * The assets that *can* be booked: active serialised items, and active single-unit
   * discrete items (a calendar hold only makes sense for one identifiable unit). Ordered
   * by name for the booking form's picker; bounded per the strict-pagination mandate.
   */
  async listBookableAssets(params: PageParams = {}): Promise<BookableAsset[]> {
    const { limit } = this.resolvePage(params);
    const rows = await this.driver.query<{ id: string; name: string; tracking_mode: string }>(
      `SELECT id, name, tracking_mode FROM items
       WHERE is_active = 1
         AND (tracking_mode = 'SERIALISED' OR (tracking_mode = 'DISCRETE' AND quantity = 1))
       ORDER BY name COLLATE NOCASE ASC
       LIMIT ?;`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, trackingMode: r.tracking_mode }));
  }

  // --- internals -----------------------------------------------------------------

  /** Active (non-terminal) day-ranges for an asset, for the overlap check. */
  private async activeRanges(itemId: string, excludeId?: string): Promise<OverlapCandidate[]> {
    const rows = await this.driver.query<{ id: string; start_date: number; end_date: number }>(
      `SELECT id, start_date, end_date FROM asset_bookings
       WHERE item_id = ? AND cancelled_at IS NULL AND converted_checkout_id IS NULL
         ${excludeId ? 'AND id <> ?' : ''};`,
      excludeId ? [itemId, excludeId] : [itemId],
    );
    return rows.map((r) => ({ id: r.id, start: Number(r.start_date), end: Number(r.end_date) }));
  }

  /** Validate a contact id (if given) or resolve-or-create from a name; null when neither. */
  private async resolveContactRef(
    contactId: string | null | undefined,
    contactName: string | null | undefined,
  ): Promise<string | null> {
    if (contactId) {
      const contact = await this.contacts.getById(contactId);
      if (!contact) {
        throw new DbError('SQLITE_CONSTRAINT', `Contact "${contactId}" does not exist.`);
      }
      return contact.id;
    }
    const name = contactName?.trim();
    if (!name) return null;
    return (await this.contacts.resolveOrCreate(name)).id;
  }

  private async requireBooking(id: string): Promise<AssetBooking> {
    const booking = await this.getById(id);
    if (!booking) {
      throw new DbError('SQLITE_CONSTRAINT', `Booking "${id}" does not exist.`);
    }
    return booking;
  }

  private async listJoined(
    where: string,
    whereParams: SqlValue[],
    params: PageParams,
    orderBy: string,
  ): Promise<Page<AssetBookingWithNames>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<BookingJoinRow>(
      `SELECT b.*, i.name AS item_name, c.name AS contact_name
       FROM asset_bookings b
       JOIN items i ON i.id = b.item_id
       LEFT JOIN contacts c ON c.id = b.contact_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?;`,
      [...whereParams, limit, offset],
    );
    return this.toPage(rows.map(toBookingWithNames), limit, offset);
  }
}

/** Compose a joined booking row into the display DTO. */
function toBookingWithNames(row: BookingJoinRow): AssetBookingWithNames {
  return {
    ...rowToBooking(row),
    itemName: row.item_name,
    contactName: row.contact_name,
  };
}
