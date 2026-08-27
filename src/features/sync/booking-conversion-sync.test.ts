import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { AssetBookingRepository, CheckoutRepository, ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #542 — converting one booking is a **one-shot terminal operation**, so two devices can
 * each run it while offline. Per-row last-write-wins cannot see that their two loans are the same
 * one: left to random ids the id-keyed union keeps both, recording a single-unit asset out to two
 * borrowers, and each device's own draw-down lands as a separate `stock_deltas` movement so the
 * Delta-CRDT replay takes the unit twice.
 *
 * The fix derives every id the conversion writes from the booking, so both devices write the
 * identical loan, ledger entry and stock movement and the merge collapses them to one. This proves
 * that end-to-end for the single-unit `DISCRETE` asset the issue describes — the case the #193
 * serialised-loan repair does not reach.
 */
async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  bookings: AssetBookingRepository;
  checkouts: CheckoutRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    bookings: new AssetBookingRepository(driver),
    checkouts: new CheckoutRepository(driver),
  };
}

type Device = Awaited<ReturnType<typeof makeDevice>>;

const NO_QUOTA = { skipQuotaCheck: true } as const;
const DAY = 86_400_000;

/** The open loans of an item on a device, by checkout id. */
async function openLoanIds(device: Device, itemId: string): Promise<string[]> {
  const page = await device.checkouts.listOpen({ limit: 100 });
  return page.rows
    .filter((r) => r.itemId === itemId)
    .map((r) => r.id)
    .sort();
}

/** The item's on-hand headline quantity on a device. */
async function onHand(device: Device, itemId: string): Promise<number> {
  return (await device.items.getById(itemId))!.quantity;
}

/** How many `CHECKED_OUT` ledger entries the item carries on a device. */
async function checkedOutEntries(device: Device, itemId: string): Promise<number> {
  const row = await device.driver.queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM item_history WHERE item_id = ? AND action = 'CHECKED_OUT';",
    [itemId],
  );
  return Number(row?.n ?? 0);
}

describe('issue #542 — one booking converted on two offline devices', () => {
  let a: Device;
  let b: Device;
  let provider: MemoryCloudProvider;
  let itemId: string;
  let bookingId: string;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();

    // A single-unit DISCRETE asset — bookable precisely because it is one physical thing — plus
    // the booking both devices are about to check out. Both sync so each holds them offline.
    const asset = await a.items.create({ name: 'Theodolite', quantity: 1 });
    itemId = asset.id;
    const booking = await a.bookings.create({
      itemId,
      startDate: Date.now() + DAY,
      endDate: Date.now() + 3 * DAY,
      contactName: 'Ada',
    });
    bookingId = booking.id;
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('converges on one loan, one ledger entry and a single unit drawn down', async () => {
    // Offline: each device checks the same booking out. Both derive the same loan id.
    const fromA = await a.bookings.convertToCheckout(bookingId);
    const fromB = await b.bookings.convertToCheckout(bookingId);
    expect(fromB.checkout.id).toBe(fromA.checkout.id);

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    // One loan, agreed by both devices, and the booking points at it on both.
    const loansA = await openLoanIds(a, itemId);
    expect(loansA).toEqual([fromA.checkout.id]);
    expect(await openLoanIds(b, itemId)).toEqual(loansA);
    expect((await a.bookings.getById(bookingId))?.convertedCheckoutId).toBe(fromA.checkout.id);
    expect((await b.bookings.getById(bookingId))?.convertedCheckoutId).toBe(fromA.checkout.id);

    // The unit was taken once, not twice — the headline count and the ledger both say so.
    expect(await onHand(a, itemId)).toBe(0);
    expect(await onHand(b, itemId)).toBe(0);
    expect(await checkedOutEntries(a, itemId)).toBe(1);
    expect(await checkedOutEntries(b, itemId)).toBe(1);
  });

  it('gives the unit back on return, on both devices', async () => {
    await a.bookings.convertToCheckout(bookingId);
    await b.bookings.convertToCheckout(bookingId);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const [survivorId] = await openLoanIds(a, itemId);
    await a.checkouts.checkIn(survivorId!);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    // Back to the one unit it always was — no shortfall, and no phantom second copy.
    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(a, itemId)).toBe(1);
    expect(await onHand(b, itemId)).toBe(1);
  });

  it('settles without further repair or churn once converged', async () => {
    await a.bookings.convertToCheckout(bookingId);
    await b.bookings.convertToCheckout(bookingId);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    const settled = await openLoanIds(a, itemId);

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await openLoanIds(a, itemId)).toEqual(settled);
    expect(await openLoanIds(b, itemId)).toEqual(settled);
    expect(await onHand(a, itemId)).toBe(0);
    expect(await onHand(b, itemId)).toBe(0);
  });

  it('keeps the loan closed when one device returned it and the other converted later', async () => {
    // A checks the booking out and gives the asset back. B, still offline, checks the same booking
    // out afterwards — so B's copy of the one loan row is the *newer* edit and would win outright.
    const { checkout } = await a.bookings.convertToCheckout(bookingId);
    await a.checkouts.checkIn(checkout.id);
    await b.bookings.convertToCheckout(bookingId);

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    // `returned_at` is write-once, so the return stands: the unit is back on the shelf and nothing
    // claims to be holding it. Letting the open copy win would leave the asset out on loan *and*
    // on hand, because the return's stock is already in the ledger either way.
    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(a, itemId)).toBe(1);
    expect(await onHand(b, itemId)).toBe(1);

    // Settled — re-syncing neither re-opens the loan nor conjures a second unit.
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(b, itemId)).toBe(1);
  });

  it('adopts the loan a half-finished conversion left behind rather than drawing again', async () => {
    // The convert is best-effort: the loan is written first, then the booking is stamped. Undo
    // just the stamp to stand in for that second write failing, then convert again.
    const first = await a.bookings.convertToCheckout(bookingId);
    await a.driver.execute('UPDATE asset_bookings SET converted_checkout_id = NULL WHERE id = ?;', [
      bookingId,
    ]);

    const second = await a.bookings.convertToCheckout(bookingId);

    expect(second.checkout.id).toBe(first.checkout.id);
    expect(await openLoanIds(a, itemId)).toEqual([first.checkout.id]);
    expect(await onHand(a, itemId)).toBe(0); // the unit was drawn once, not twice
    expect(await checkedOutEntries(a, itemId)).toBe(1);
  });
});
