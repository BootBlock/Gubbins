import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { AssetBookingRepository, ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #194 — a booking holds one identifiable asset for a span of days, so two active bookings
 * of the same asset over overlapping days are a double-booking. `AssetBookingRepository.create`'s
 * overlap guard stops a clashing booking on one device, but two devices offline can each pass it,
 * and the id-keyed LWW union would otherwise keep both. This proves the merge collapses that
 * end-to-end: after convergence exactly one booking stays active, both devices agree on which, and
 * the repair does not churn.
 */
async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  bookings: AssetBookingRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    bookings: new AssetBookingRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

/** A day-start anchor plus whole-day offsets, so the suite holds in any time zone. */
const DAY0 = new Date(2026, 0, 5).setHours(0, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const day = (n: number): number => DAY0 + n * DAY;

/** The active (non-cancelled, non-converted) booking ids of an asset on a device, sorted. */
async function activeBookingIds(
  device: Awaited<ReturnType<typeof makeDevice>>,
  itemId: string,
): Promise<string[]> {
  const page = await device.bookings.listForItem(itemId, { limit: 100 });
  return page.rows
    .filter((b) => b.cancelledAt === null && b.convertedCheckoutId === null)
    .map((b) => b.id)
    .sort();
}

describe('issue #194 — asset booked for overlapping dates across two offline devices', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;
  let itemId: string;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();

    // A creates the bookable asset and both devices sync so each holds it before going offline.
    const [asset] = await a.items.createSerialised({ name: 'Laser cutter', trackingMode: 'SERIALISED' });
    itemId = asset!.id;
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('keeps exactly one active booking, agreed by both devices, and does not churn', async () => {
    // Offline: each device books the same asset for overlapping dates for a different contact.
    await a.bookings.create({ itemId, contactName: 'Ada', startDate: day(1), endDate: day(3) });
    await b.bookings.create({ itemId, contactName: 'Grace', startDate: day(2), endDate: day(4) });

    // A publishes its booking; B pulls it and now holds two overlapping bookings → merge cancels one.
    await runSync(a.driver, provider, NO_QUOTA);
    const onB = await runSync(b.driver, provider, NO_QUOTA);
    expect(onB.bookingsCancelled).toBe(1);

    // A pulls B's converged state: the loser already arrives cancelled, so A cancels nothing itself.
    const onA = await runSync(a.driver, provider, NO_QUOTA);
    expect(onA.bookingsCancelled).toBe(0);

    const activeA = await activeBookingIds(a, itemId);
    const activeB = await activeBookingIds(b, itemId);
    expect(activeA).toHaveLength(1);
    expect(activeB).toEqual(activeA); // both devices kept the same booking

    // Re-syncing settles with no further repair and no churn (the loser stays cancelled).
    expect((await runSync(a.driver, provider, NO_QUOTA)).bookingsCancelled).toBe(0);
    expect((await runSync(b.driver, provider, NO_QUOTA)).bookingsCancelled).toBe(0);
    expect(await activeBookingIds(a, itemId)).toEqual(activeA);
    expect(await activeBookingIds(b, itemId)).toEqual(activeA);
  });

  it('leaves two non-overlapping bookings of the same asset alone', async () => {
    await a.bookings.create({ itemId, contactName: 'Ada', startDate: day(1), endDate: day(2) });
    await b.bookings.create({ itemId, contactName: 'Grace', startDate: day(5), endDate: day(6) });

    await runSync(a.driver, provider, NO_QUOTA);
    const onB = await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    expect(onB.bookingsCancelled).toBe(0);
    expect(await activeBookingIds(a, itemId)).toHaveLength(2);
    expect(await activeBookingIds(b, itemId)).toHaveLength(2);
  });
});
