import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { WishlistRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Feature-gap G8 — the synced `wishlist` table round-trips between two devices (§7.3). A wishlist
 * entry is an independent, no-FK LWW row carrying its own `updated_at` with a random-UUID id, so
 * once it joined `SYNC_TABLES` it publishes, reconciles and deletes through the same generic engine
 * path every other entity table uses — no bespoke reconcile handling, no FK guard needed.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; wishlist: WishlistRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, wishlist: new WishlistRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('wishlist sync round-trip (§7.3)', () => {
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

  it('publishes an entry, then a peer pulls it', async () => {
    await a.wishlist.create({
      name: 'Impact driver',
      note: 'wait for a sale',
      url: 'https://example.test/driver',
      targetPrice: 180,
      priority: 'HIGH',
    });

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    const pulled = (await b.wishlist.list()).rows;
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({
      name: 'Impact driver',
      url: 'https://example.test/driver',
      targetPrice: 180,
      priority: 'HIGH',
    });
  });

  it('propagates an edit by last-writer-wins', async () => {
    const entry = await a.wishlist.create({ name: 'Filters', priority: 'LOW' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    await a.wishlist.update(entry.id, { priority: 'HIGH', targetPrice: 24 });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    const pulled = await b.wishlist.getById(entry.id);
    expect(pulled).toMatchObject({ priority: 'HIGH', targetPrice: 24 });
  });

  it('propagates a removal via a tombstone', async () => {
    const entry = await a.wishlist.create({ name: 'Gone' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect((await b.wishlist.list()).rows).toHaveLength(1);

    await a.wishlist.delete(entry.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect((await b.wishlist.list()).rows).toHaveLength(0);
  });
});
