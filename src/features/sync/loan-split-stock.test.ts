import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  AssetBookingRepository,
  CheckoutRepository,
  ItemRepository,
  LocationRepository,
} from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #711 — one loan, drawn from two different placements.
 *
 * Since issue #542 a booking conversion derives its ids from the booking, so two devices that each
 * convert the same booking offline write the *same* `checkouts` row. The stock does not follow:
 * each device draws the unit from wherever it last saw the asset, so a device that moved it before
 * converting draws it from somewhere else and the two draws land at two placements under two ids.
 * `reconcileStockQuantity` replays one placement at a time, so nothing ever put the two side by
 * side, and the asymmetric return — both convert, exactly one hands the asset back — left the unit
 * neither on loan nor on hand, on both devices, with no further sync able to recover it.
 *
 * These drive the whole loan cycle through a real merge, because the invariant at stake is a
 * cross-device one: a single-unit asset is worth exactly one unit at every point, and the pass that
 * cancels the surplus draw has to hold that without breaking the two cases that were already
 * right — both devices returning, and neither.
 */
async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  locations: LocationRepository;
  bookings: AssetBookingRepository;
  checkouts: CheckoutRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    locations: new LocationRepository(driver),
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

/** Every placement's quantity on a device, keyed by location, so a total can be attributed. */
async function placements(device: Device, itemId: string): Promise<Map<string, number>> {
  const rows = await device.driver.query<{ location_id: string; quantity: number }>(
    'SELECT location_id, SUM(quantity) AS quantity FROM stock_batches WHERE item_id = ? GROUP BY location_id;',
    [itemId],
  );
  return new Map(rows.map((r) => [String(r.location_id), Number(r.quantity)]));
}

/** How many `stock_deltas` rows the item carries — the ledger's own size, for the churn check. */
async function ledgerSize(device: Device, itemId: string): Promise<number> {
  const row = await device.driver.queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM stock_deltas WHERE item_id = ?;',
    [itemId],
  );
  return Number(row?.n ?? 0);
}

describe('issue #711 — one loan drawn from two placements', () => {
  let a: Device;
  let b: Device;
  let provider: MemoryCloudProvider;
  let itemId: string;
  let bookingId: string;
  let shelfId: string;
  let vanId: string;

  /** Both devices online and agreed: one unit on the shelf, one booking waiting to be converted. */
  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();

    shelfId = (await a.locations.create({ name: 'Shelf' })).id;
    vanId = (await a.locations.create({ name: 'Van' })).id;
    const asset = await a.items.create({ name: 'Theodolite', quantity: 1, locationId: shelfId });
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

  /** Sync both devices to a standstill, in both directions. */
  async function settle(): Promise<void> {
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
  }

  /** A moves the asset to the van; both devices then convert the one booking, still offline. */
  async function moveThenBothConvert(): Promise<{ fromA: string; fromB: string }> {
    await a.items.move(itemId, vanId);
    const fromA = await a.bookings.convertToCheckout(bookingId);
    const fromB = await b.bookings.convertToCheckout(bookingId);
    return { fromA: fromA.checkout.id, fromB: fromB.checkout.id };
  }

  it('gives the unit back when only one device returns the loan, offline', async () => {
    // The issue's own case: A draws from the van, B (which never saw the move) draws from the
    // shelf, and only B hands the asset back. Before the fix both draws stood, the single merged
    // loan closed against one of them, and the unit was neither on loan nor on hand.
    const { fromB } = await moveThenBothConvert();
    await b.checkouts.checkIn(fromB);
    await settle();

    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(a, itemId)).toBe(1);
    expect(await onHand(b, itemId)).toBe(1);
  });

  it('gives the unit back when only one device returns the loan after merging', async () => {
    // A guard rather than a regression: with the devices meeting BEFORE the return, the return is
    // planned against the merged loan row and the count already came out right without this pass.
    // It is here so the cancellation cannot break the case it was not written for.
    await moveThenBothConvert();
    await settle();

    const [survivor] = await openLoanIds(a, itemId);
    expect(survivor).toBeDefined();
    await b.checkouts.checkIn(survivor!);
    await settle();

    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(a, itemId)).toBe(1);
    expect(await onHand(b, itemId)).toBe(1);
  });

  it('keeps the unit out on loan while neither device returns it', async () => {
    // The surplus draw is cancelled, not honoured: one loan is open, so nothing is on hand — the
    // cancellation must not hand the unit back early.
    await moveThenBothConvert();
    await settle();

    expect(await openLoanIds(a, itemId)).toHaveLength(1);
    expect(await openLoanIds(b, itemId)).toEqual(await openLoanIds(a, itemId));
    expect(await onHand(a, itemId)).toBe(0);
    expect(await onHand(b, itemId)).toBe(0);
    // Neither placement holds a phantom copy of the asset either.
    expect([...(await placements(a, itemId)).values()].filter((q) => q !== 0)).toEqual([]);
  });

  it('gives the unit back once when both devices return their own conversion', async () => {
    // The return splits exactly as the draw does, and the two halves used to cancel each other by
    // luck. Cancelling only the surplus *draw* would leave two restores against one draw, so the
    // return is examined under its own key for the same shape.
    const { fromA, fromB } = await moveThenBothConvert();
    await a.checkouts.checkIn(fromA);
    await b.checkouts.checkIn(fromB);
    await settle();

    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
    expect(await onHand(a, itemId)).toBe(1); // one unit, not two
    expect(await onHand(b, itemId)).toBe(1);
  });

  it('settles without further repair or churn once converged', async () => {
    // The cancellation is derived from the row it cancels, so re-running the pass re-derives the
    // same row for `INSERT OR IGNORE` to skip. A ledger that kept growing here would be the tell
    // that two devices disagree about which draw to cancel.
    await moveThenBothConvert();
    await settle();

    const ledger = await ledgerSize(a, itemId);
    expect(await ledgerSize(b, itemId)).toBe(ledger);
    const settled = await placements(a, itemId);

    await settle();
    expect(await ledgerSize(a, itemId)).toBe(ledger);
    expect(await ledgerSize(b, itemId)).toBe(ledger);
    expect(await placements(a, itemId)).toEqual(settled);
    expect(await placements(b, itemId)).toEqual(settled);
    expect(await onHand(a, itemId)).toBe(0);
  });

  it('leaves a loan both devices drew from the same placement untouched', async () => {
    // No move, so both devices draw the unit from the shelf and mint the identical delta id. The
    // union already collapses that to one movement, and this pass must add nothing to it.
    await a.bookings.convertToCheckout(bookingId);
    await b.bookings.convertToCheckout(bookingId);
    await settle();

    const rows = await a.driver.query<{ id: string }>(
      'SELECT id FROM stock_deltas WHERE item_id = ? AND id LIKE ?;',
      [itemId, '~%'],
    );
    expect(rows).toEqual([]);
    expect(await onHand(a, itemId)).toBe(0);
    expect(await openLoanIds(a, itemId)).toHaveLength(1);
  });

  it('records the draw operation key only for a loan whose ids are derived', async () => {
    // The key is the handle the merge pairs two draws by. An ordinary loan is a genuinely new event
    // with random delta ids and nothing to pair up, so it must not claim a key it never captured
    // its draw under — which would send the pass looking for rows that do not exist.
    const { checkout: converted } = await a.bookings.convertToCheckout(bookingId);
    const spares = await a.items.create({ name: 'Ranging rod', quantity: 4, locationId: shelfId });
    const plain = await a.checkouts.checkout({ itemId: spares.id, contactName: 'Grace', quantity: 1 });

    const keyOf = async (id: string): Promise<string | null> => {
      const row = await a.driver.queryOne<{ stock_operation_key: string | null }>(
        'SELECT stock_operation_key FROM checkouts WHERE id = ?;',
        [id],
      );
      return row?.stock_operation_key ?? null;
    };
    expect(await keyOf(converted.id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await keyOf(plain.id)).toBeNull();
  });
});
