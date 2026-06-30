import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { AssetBookingRepository, ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Phase 78 — the synced `asset_bookings` table round-trips between two devices (§7.3).
 * A booking is a plain LWW row carrying its own `updated_at`, so once it joined
 * `SYNC_TABLES` it publishes, reconciles by last-write-wins, and tombstone-deletes through
 * the same generic engine path every other entity table uses — proven end-to-end here.
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
const DAY = 86_400_000;

describe('asset_bookings sync round-trip (§7.3)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('publishes a booking, then a peer pulls it', async () => {
    const [asset] = await a.items.createSerialised({ name: 'Laser cutter', trackingMode: 'SERIALISED' });
    const booking = await a.bookings.create({
      itemId: asset!.id,
      startDate: Date.now() + 3 * DAY,
      endDate: Date.now() + 5 * DAY,
      contactName: 'Ada',
    });

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    const onB = await b.bookings.getById(booking.id);
    expect(onB?.startDate).toBe(booking.startDate);
    expect(onB?.endDate).toBe(booking.endDate);
  });

  it('reconciles a cancellation (LWW) and a deletion (tombstone) to the peer', async () => {
    const [asset] = await a.items.createSerialised({ name: 'Plotter', trackingMode: 'SERIALISED' });
    const keep = await a.bookings.create({ itemId: asset!.id, startDate: Date.now() + DAY, endDate: Date.now() + 2 * DAY });
    const drop = await a.bookings.create({ itemId: asset!.id, startDate: Date.now() + 4 * DAY, endDate: Date.now() + 5 * DAY });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.bookings.getById(keep.id)).toBeDefined();
    expect(await b.bookings.getById(drop.id)).toBeDefined();

    // A cancels `keep` (LWW update) and removes `drop` (tombstone).
    await a.bookings.cancel(keep.id);
    await a.bookings.remove(drop.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect((await b.bookings.getById(keep.id))?.cancelledAt).not.toBeNull();
    expect(await b.bookings.getById(drop.id)).toBeUndefined();
  });
});
