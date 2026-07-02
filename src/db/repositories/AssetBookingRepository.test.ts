import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations';
import { migrations } from '@/db/migrations/index';
import { MS_PER_DAY } from './constants';
import { AssetBookingRepository } from './AssetBookingRepository';
import { ItemRepository } from './ItemRepository';

/** Local-midday instant `n` whole days from a fixed anchor (timezone-robust). */
const ANCHOR = new Date(2026, 5, 10, 12, 0, 0).getTime();
const day = (n: number): number => ANCHOR + n * MS_PER_DAY;
const dayStart = (n: number): number => {
  const d = new Date(day(n));
  d.setHours(0, 0, 0, 0);
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

  it('creates a booking, snapping the range to whole local days', async () => {
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

  it('requires a contact to convert a booking that has none', async () => {
    const itemId = await serialisedAsset();
    const booking = await bookings.create({ itemId, startDate: day(1), endDate: day(2) });
    await expect(bookings.convertToCheckout(booking.id)).rejects.toBeInstanceOf(DbError);
    const { checkout } = await bookings.convertToCheckout(booking.id, { contactName: 'Grace' });
    expect(checkout.itemId).toBe(itemId);
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

  it('lists bookable assets (active serialised + single-unit discrete only)', async () => {
    await serialisedAsset('Scope');
    await items.create({ name: 'Single', quantity: 1 });
    await items.create({ name: 'Bulk', quantity: 9 });
    const assets = await bookings.listBookableAssets();
    const names = assets.map((a) => a.name).sort();
    expect(names).toEqual(['Scope', 'Single']);
  });
});
