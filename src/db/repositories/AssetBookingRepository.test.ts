import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations';
import { migrations } from '@/db/migrations/index';
import { MS_PER_DAY } from './constants';
import { AssetBookingRepository, bookingConversionId } from './AssetBookingRepository';
import { ItemRepository } from './ItemRepository';

// Midday-UTC instant `n` whole days from a fixed anchor, and its midnight-UTC day-start. Bookings
// store midnight UTC (issue #320), so deriving both from a UTC base keeps the suite timezone-robust.
const ANCHOR = Date.UTC(2026, 5, 10, 12, 0, 0);
const day = (n: number): number => ANCHOR + n * MS_PER_DAY;
const dayStart = (n: number): number => {
  const d = new Date(day(n));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

describe('AssetBookingRepository (Phase 78 — time-based asset booking)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let bookings: AssetBookingRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    bookings = new AssetBookingRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function serialisedAsset(name = '3D printer'): Promise<string> {
    const [item] = await items.createSerialised({ name, trackingMode: 'SERIALISED' });
    return item!.id;
  }

  it('creates a booking, snapping the range to whole UTC days', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({
      itemId,
      startDate: day(5),
      endDate: day(7),
      contactName: 'Ada',
      note: '  trade show  ',
    });
    expect(booking.startDate).toBe(dayStart(5));
    expect(booking.endDate).toBe(dayStart(7));
    expect(booking.note).toBe('trade show');
    expect(booking.contactId).not.toBeNull();
    expect(booking.cancelledAt).toBeNull();
    expect(booking.convertedCheckoutId).toBeNull();
  });

  it('normalises a reversed range so end is never before start', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(7), endDate: day(5) });
    expect(booking.startDate).toBe(dayStart(5));
    expect(booking.endDate).toBe(dayStart(7));
  });

  it('only allows serialised or single-unit discrete assets to be booked', async () => {
    const single = await items.create({ name: 'Torque wrench', quantity: 1 });
    const multi = await items.create({ name: 'Resistor pack', quantity: 5 });
    await expect(
      bookings.create({ itemId: single.id, startDate: day(1), endDate: day(2) }),
    ).resolves.toBeDefined();
    await expect(
      bookings.create({ itemId: multi.id, startDate: day(1), endDate: day(2) }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('hard-prevents an overlapping booking for the same asset', async () => {
    const itemId = await serialisedAsset();
    await bookings.create({ itemId, startDate: day(5), endDate: day(7) });
    // Overlaps day 6–7.
    await expect(bookings.create({ itemId, startDate: day(6), endDate: day(8) })).rejects.toBeInstanceOf(
      DbError,
    );
    // Same-day touch (day 7) is a clash.
    await expect(bookings.create({ itemId, startDate: day(7), endDate: day(9) })).rejects.toBeInstanceOf(
      DbError,
    );
    // Adjacent (starts day 8, the day after) is allowed.
    await expect(bookings.create({ itemId, startDate: day(8), endDate: day(9) })).resolves.toBeDefined();
  });

  it('a cancelled booking no longer blocks an overlapping range', async () => {
    const itemId = await serialisedAsset();
    const first = await bookings.create({ itemId, startDate: day(5), endDate: day(7) });
    await bookings.cancel(first.id);
    await expect(bookings.create({ itemId, startDate: day(6), endDate: day(8) })).resolves.toBeDefined();
  });

  it('cancels a booking idempotently and refuses to cancel a converted one', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(2), contactName: 'Ada' });
    const cancelled = await bookings.cancel(booking.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    // Idempotent.
    const again = await bookings.cancel(booking.id);
    expect(again.cancelledAt).toBe(cancelled.cancelledAt);
  });

  it('converts a booking into a checkout and stamps the pointer', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(3), contactName: 'Ada' });
    const { booking: converted, checkout } = await bookings.convertToCheckout(booking.id);
    expect(checkout.itemId).toBe(itemId);
    expect(checkout.returnedAt).toBeNull();
    expect(converted.convertedCheckoutId).toBe(checkout.id);
    // A converted booking cannot be converted again or cancelled.
    await expect(bookings.convertToCheckout(booking.id)).rejects.toBeInstanceOf(DbError);
    await expect(bookings.cancel(booking.id)).rejects.toBeInstanceOf(DbError);
  });

  it('derives the loan and its ledger entry from the booking so concurrent conversions converge', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(3), contactName: 'Ada' });

    const { checkout } = await bookings.convertToCheckout(booking.id);

    // Both are pure functions of the booking id, not fresh random UUIDs — the property that makes
    // two devices' offline conversions write the *same* loan and merge to one (issue #542).
    expect(checkout.id).toBe(await bookingConversionId('checkout', booking.id));
    const entry = (await items.getHistory(itemId)).rows.find((h) => h.action === 'CHECKED_OUT');
    expect(entry?.id).toBe(await bookingConversionId('hist:CHECKED_OUT', booking.id));
  });

  it('requires a contact to convert a booking that has none', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await expect(bookings.convertToCheckout(booking.id)).rejects.toBeInstanceOf(DbError);
    const { checkout, booking: stamped } = await bookings.convertToCheckout(booking.id, {
      contactName: 'Grace',
    });
    expect(checkout.itemId).toBe(itemId);
    // The borrower named at conversion is recorded on the booking too, so it no longer reads as
    // checked out to nobody in the list and the export (issue #659).
    expect(stamped.contactId).toBe(checkout.contactId);
    expect(stamped.contactId).not.toBeNull();
  });

  it('refuses to convert a booking whose asset has since been decommissioned (#661)', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(3), contactName: 'Ada' });
    // The booking outlives the decommission, so its check-out action still reaches the repository.
    await items.softDelete(itemId);

    await expect(bookings.convertToCheckout(booking.id)).rejects.toThrow(/decommissioned/i);
    // The booking stays open and unstamped, so it can still be cancelled — or converted after a restore.
    expect((await bookings.getById(booking.id))?.convertedCheckoutId).toBeNull();
  });

  it('listUpcoming excludes cancelled, converted and fully-past bookings', async () => {
    const a = await serialisedAsset('Printer A');
    const b = await serialisedAsset('Printer B');
    const c = await serialisedAsset('Printer C');
    const past = await serialisedAsset('Printer D');

    await bookings.create({ itemId: a, startDate: day(3), endDate: day(5) }); // upcoming
    const toCancel = await bookings.create({ itemId: b, startDate: day(4), endDate: day(6) });
    await bookings.cancel(toCancel.id);
    const toConvert = await bookings.create({
      itemId: c,
      startDate: day(2),
      endDate: day(4),
      contactName: 'Ada',
    });
    await bookings.convertToCheckout(toConvert.id);
    await bookings.create({ itemId: past, startDate: day(-5), endDate: day(-3) }); // ended in the past

    const page = await bookings.listUpcoming(day(0), { limit: 100 });
    const names = page.rows.map((r) => r.itemName);
    expect(names).toEqual(['Printer A']);
  });

  it('tombstones a removed booking for sync', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await bookings.remove(booking.id);
    expect(await bookings.getById(booking.id)).toBeUndefined();
    const tomb = await driver.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'asset_bookings' AND id = ?;",
      [booking.id],
    );
    expect(Number(tomb?.n)).toBe(1);
  });

  // --- editing a booking (issue #659) -------------------------------------------

  it('names a borrower on a contactless booking, so it can then be checked out', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await expect(bookings.convertToCheckout(booking.id)).rejects.toBeInstanceOf(DbError);

    const updated = await bookings.update(booking.id, { contactName: 'Grace' });
    expect(updated.contactId).not.toBeNull();

    const { checkout } = await bookings.convertToCheckout(booking.id);
    expect(checkout.itemId).toBe(itemId);
  });

  it('recovers a booking whose contact was deleted (ON DELETE SET NULL)', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({
      itemId,
      startDate: day(1),
      endDate: day(2),
      contactName: 'Ada',
    });
    // Deleting the contact strips the borrower from the booking rather than blocking the delete.
    await driver.execute('DELETE FROM contacts WHERE id = ?;', [booking.contactId!]);
    expect((await bookings.getById(booking.id))?.contactId).toBeNull();
    await expect(bookings.convertToCheckout(booking.id)).rejects.toBeInstanceOf(DbError);

    await bookings.update(booking.id, { contactName: 'Ada' });
    const { checkout } = await bookings.convertToCheckout(booking.id);
    expect(checkout.itemId).toBe(itemId);
  });

  it('clears the contact when the name is cleared', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({
      itemId,
      startDate: day(1),
      endDate: day(2),
      contactName: 'Ada',
    });
    const updated = await bookings.update(booking.id, { contactName: null });
    expect(updated.contactId).toBeNull();
  });

  it('leaves a field alone when the input omits it', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({
      itemId,
      startDate: day(1),
      endDate: day(2),
      contactName: 'Ada',
      note: 'trade show',
    });
    const updated = await bookings.update(booking.id, { note: 'rescheduled' });
    expect(updated.contactId).toBe(booking.contactId);
    expect(updated.startDate).toBe(dayStart(1));
    expect(updated.endDate).toBe(dayStart(2));
    expect(updated.note).toBe('rescheduled');
  });

  it('moves the dates, snapping to whole UTC days and ignoring its own reservation', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(5) });
    // The new range overlaps the booking's *current* one — which must not count as a clash.
    const updated = await bookings.update(booking.id, { startDate: day(3), endDate: day(7) });
    expect(updated.startDate).toBe(dayStart(3));
    expect(updated.endDate).toBe(dayStart(7));
  });

  it('still refuses a move that overlaps another booking of the same asset', async () => {
    const itemId = await serialisedAsset();
    const first = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await bookings.create({ itemId, startDate: day(5), endDate: day(7) });

    await expect(bookings.update(first.id, { endDate: day(6) })).rejects.toBeInstanceOf(DbError);
    // The refused edit changed nothing.
    const unchanged = await bookings.getById(first.id);
    expect(unchanged?.endDate).toBe(dayStart(2));
  });

  it('refuses to edit a cancelled or converted booking', async () => {
    const itemId = await serialisedAsset('Printer A');
    const cancelled = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await bookings.cancel(cancelled.id);
    await expect(bookings.update(cancelled.id, { contactName: 'Ada' })).rejects.toBeInstanceOf(DbError);

    const otherId = await serialisedAsset('Printer B');
    const converted = await bookings.create({
      itemId: otherId,
      startDate: day(1),
      endDate: day(2),
      contactName: 'Ada',
    });
    await bookings.convertToCheckout(converted.id);
    await expect(bookings.update(converted.id, { note: 'late' })).rejects.toBeInstanceOf(DbError);
  });

  it('lists bookable assets (active serialised + single-unit discrete only)', async () => {
    await serialisedAsset('Scope');
    await items.create({ name: 'Single', quantity: 1 });
    await items.create({ name: 'Bulk', quantity: 9 });
    const assets = await bookings.listBookableAssets();
    const names = assets.map((a) => a.name).sort();
    expect(names).toEqual(['Scope', 'Single']);
  });
});
