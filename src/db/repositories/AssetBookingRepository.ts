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
  type OverlapCandidate,
} from '@/features/bookings/booking-overlap';
import { startOfUtcDay } from '@/lib/calendar-days';
import { uuidv5 } from '@/lib/derived-uuid';
import { isBookableTrackingMode } from '@/features/bookings/booking-status';
import { BaseRepository, collaboratorOptions, type RepositoryOptions } from './base';
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
  UpdateBookingInput,
} from './types';

/**
 * Namespace for the deterministic ids a booking→checkout conversion mints (issue #542).
 *
 * Converting is a **one-shot terminal operation**: a booking becomes a loan exactly once, and two
 * devices can each perform that conversion while offline. Left to `crypto.randomUUID()` they mint
 * two `checkouts` rows with two ids, and the id-keyed last-write-wins union keeps both — the same
 * unit recorded out to two borrowers, with a doubled stock draw-down behind it. Deriving every id
 * the conversion writes from the stable booking id makes both devices compute the *same* ids, so
 * the merge collapses their two runs to one loan. The same fix issue #195 applied to assembly
 * finalisation, for the other one-shot operation in the app.
 */
const BOOKING_CONVERSION_NAMESPACE = '9b7c1f0a-1950-4e00-8b00-000000000542';

/**
 * The deterministic id a conversion gives to `kind` for `bookingId` (see
 * {@link BOOKING_CONVERSION_NAMESPACE}). A pure function of its inputs, which is exactly the
 * convergence property: two devices converting the same booking offline derive the same ids.
 *
 * @internal Exported for unit tests only.
 */
export function bookingConversionId(kind: string, bookingId: string): Promise<string> {
  return uuidv5(`${kind}:${bookingId}`, BOOKING_CONVERSION_NAMESPACE);
}

interface BookingJoinRow extends AssetBookingRow {
  readonly item_name: string;
  readonly contact_name: string | null;
}

export class AssetBookingRepository extends BaseRepository {
  private readonly contacts: ContactRepository;
  private readonly checkouts: CheckoutRepository;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    super(driver, options);
    this.contacts = new ContactRepository(driver, collaboratorOptions(options));
    this.checkouts = new CheckoutRepository(driver, collaboratorOptions(options));
  }

  async getById(id: string): Promise<AssetBooking | undefined> {
    const row = await this.driver.queryOne<AssetBookingRow>('SELECT * FROM asset_bookings WHERE id = ?;', [
      id,
    ]);
    return row ? rowToBooking(row) : undefined;
  }

  /**
   * Reserve a bookable asset for a whole-day date range. The range is snapped to midnight-UTC
   * day starts; the asset must be serialised or single-unit discrete; and the range must not
   * overlap any active booking for the same asset (hard double-booking prevention).
   */
  async create(input: CreateBookingInput): Promise<AssetBooking> {
    this.assertPermission('bookings:write');
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
      throw new DbError('SQLITE_CONSTRAINT', 'This asset is already booked for an overlapping date range.');
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
    this.assertPermission('bookings:write');
    this.assertWritable();
    const booking = await this.requireBooking(id);
    if (booking.cancelledAt !== null) return booking; // already cancelled — idempotent
    if (booking.convertedCheckoutId !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'A booking that was checked out cannot be cancelled.');
    }
    await this.driver.execute(`UPDATE asset_bookings SET cancelled_at = (${SQL_NOW_MS}) WHERE id = ?;`, [id]);
    return (await this.getById(id))!;
  }

  /**
   * Amend an open booking in place — its contact, its day range and its note (issue #659).
   *
   * A booking can legitimately be made with **no** contact (the form invites it: "leave blank if
   * you're only reserving the slot"), and `asset_bookings.contact_id` is `ON DELETE SET NULL`, so
   * deleting a contact strips the borrower from their future bookings as well. Either way
   * {@link convertToCheckout} then refuses the booking for want of a borrower — and before this
   * existed the only exits were Cancel and Delete, both of which release the reserved slot. This
   * is the recovery: name the borrower (or correct the dates) and the reservation survives.
   *
   * Only the fields present in `input` change; see {@link UpdateBookingInput}. A terminal booking
   * is not editable — a cancelled or converted booking is a record of what happened, and the
   * conversion has already copied the note and dates onto a loan that owns them from then on.
   *
   * A moved range is re-checked for clashes exactly as {@link create} does, **excluding the
   * booking's own row** — otherwise every edit would collide with the reservation it is editing.
   */
  async update(id: string, input: UpdateBookingInput): Promise<AssetBooking> {
    this.assertPermission('bookings:write');
    this.assertWritable();
    const booking = await this.requireBooking(id);
    if (booking.cancelledAt !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'A cancelled booking cannot be edited.');
    }
    if (booking.convertedCheckoutId !== null) {
      throw new DbError('SQLITE_CONSTRAINT', 'A booking that was checked out cannot be edited.');
    }

    const sets: string[] = [];
    const params: SqlValue[] = [];

    if (input.startDate !== undefined || input.endDate !== undefined) {
      const { start, end } = normaliseDayRange(
        input.startDate ?? booking.startDate,
        input.endDate ?? booking.endDate,
      );
      const clash = findFirstOverlap({ start, end }, await this.activeRanges(booking.itemId, id));
      if (clash) {
        throw new DbError('SQLITE_CONSTRAINT', 'This asset is already booked for an overlapping date range.');
      }
      sets.push('start_date = ?', 'end_date = ?');
      params.push(start, end);
    }

    if (input.contactId !== undefined || input.contactName !== undefined) {
      sets.push('contact_id = ?');
      params.push(await this.resolveContactRef(input.contactId, input.contactName));
    }

    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(input.note?.trim() || null);
    }

    if (sets.length > 0) {
      await this.driver.execute(`UPDATE asset_bookings SET ${sets.join(', ')} WHERE id = ?;`, [
        ...params,
        id,
      ]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Convert a booking into an active checkout: delegate the stock decrement + serialised
   * double-out guard to {@link CheckoutRepository.checkout}, then stamp the booking's
   * `converted_checkout_id`. The loan due date defaults to the booking's end day.
   *
   * Every id the conversion writes is **derived from the booking** rather than minted at random
   * (issue #542, via {@link bookingConversionId}): the loan's own row id, its `CHECKED_OUT` ledger
   * entry, and the key the draw's `stock_deltas` ids come from. Converting is a one-shot terminal
   * operation two devices can each run offline, and per-row last-write-wins cannot see that their
   * two loans are the same one — so without derived ids the merge keeps both, leaving a single
   * unit out to two borrowers with the stock drawn down twice behind it. Derived, both devices
   * write the identical rows and the merge collapses them to one. See {@link CheckoutDerivedIds}.
   *
   * Best-effort (non-atomic): the checkout is created in its own transaction, then the booking is
   * stamped in a second write. The window is tiny, and the derived ids make it recoverable rather
   * than merely narrow — if the stamp fails, the loan the first attempt created is found by its
   * derived id and the re-convert simply stamps the booking onto it instead of drawing a second
   * time. Mirrors the Phase-76 clone "best-effort" decision.
   */
  async convertToCheckout(
    id: string,
    input: ConvertBookingInput = {},
  ): Promise<{ booking: AssetBooking; checkout: Checkout }> {
    this.assertPermission('bookings:write');
    this.assertPermission('checkouts:write');
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
      throw new DbError('SQLITE_CONSTRAINT', 'Add a contact to the booking before checking it out.');
    }

    const derivedIds = {
      checkoutId: await bookingConversionId('checkout', id),
      historyId: await bookingConversionId('hist:CHECKED_OUT', id),
      operationKey: await bookingConversionId('stock', id),
    };

    // Recover a conversion whose stamp failed after the loan was written (see the doc comment):
    // the loan is already there under its derived id, so re-running must adopt it rather than
    // draw the unit down a second time.
    const checkout =
      (await this.checkouts.getById(derivedIds.checkoutId)) ??
      (await this.checkouts.checkout({
        itemId: booking.itemId,
        contactId,
        contactName,
        dueDate: input.dueDate ?? booking.endDate,
        note: input.note?.trim() || booking.note,
        derivedIds,
      }));

    // A booking converted with a borrower supplied at this moment (issue #659) had none of its
    // own, so the stamp records who it actually went to as well. Without it the booking reads
    // "checked out" to nobody for the rest of its life, in the list and in every export.
    await this.driver.execute(
      'UPDATE asset_bookings SET converted_checkout_id = ?, contact_id = ? WHERE id = ?;',
      [checkout.id, booking.contactId ?? checkout.contactId, id],
    );
    return { booking: (await this.getById(id))!, checkout };
  }

  /** Permanently remove a booking. Tombstoned for sync (§7.2). */
  async remove(id: string): Promise<void> {
    this.assertPermission('bookings:delete');
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

  /**
   * All bookings, open (non-terminal) first then by soonest start — the bookings screen feed.
   *
   * The `b.id` tiebreak makes the order **total** (issue #132). Bookings frequently share a start
   * date (a whole week booked out on the Monday), so without it the sort is only partially
   * determined, and the export's offset walk over this read could return one booking on two
   * consecutive pages while dropping another. The screen's own single-page read is unaffected;
   * the tiebreak costs nothing and makes paging correct.
   */
  async list(params: PageParams = {}): Promise<Page<AssetBookingWithNames>> {
    return this.listJoined(
      '',
      [],
      params,
      '(b.cancelled_at IS NULL AND b.converted_checkout_id IS NULL) DESC, b.start_date ASC, b.id ASC',
    );
  }

  /**
   * Active (non-cancelled, non-converted) bookings whose window has not entirely passed —
   * the §3 "Upcoming" agenda + bookings-screen feed. `now` is injected so the start-of-today
   * cut-off is deterministic and testable; ordered by soonest start.
   */
  async listUpcoming(now: number, params: PageParams = {}): Promise<Page<AssetBookingWithNames>> {
    // Keep a booking until the end of its last booked day. Bookings store midnight UTC (issue #320),
    // so the "start of today" cut-off is taken in UTC too, keeping it in one frame with `end_date`.
    const cutoff = startOfUtcDay(now);
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

  /**
   * Active (non-terminal) day-ranges for an asset, for the overlap check. `excludeId` omits one
   * booking from the candidates — {@link update} passes the booking being edited, which would
   * otherwise always clash with itself.
   */
  private async activeRanges(itemId: string, excludeId?: string): Promise<OverlapCandidate[]> {
    const rows = await this.driver.query<{ id: string; start_date: number; end_date: number }>(
      `SELECT id, start_date, end_date FROM asset_bookings
       WHERE item_id = ? AND cancelled_at IS NULL AND converted_checkout_id IS NULL
         AND (? IS NULL OR id <> ?);`,
      [itemId, excludeId ?? null, excludeId ?? null],
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
