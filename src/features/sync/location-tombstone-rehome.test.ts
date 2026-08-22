import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, LocationRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #709 — applying a peer's `locations` tombstone re-homes the stock still standing at
 * that location into Unassigned. The peer performed that same re-home locally before it
 * pushed, so its snapshot already carries the Unassigned placement at the full quantity, and
 * the merge's LWW upserts write it moments earlier. Accumulating this device's own shelf row
 * on top of that figure counted the same units twice.
 */
async function makeDevice() {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return {
    driver,
    items: new ItemRepository(driver),
    locations: new LocationRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

async function stockSum(driver: MemoryDriver, itemId: string): Promise<number> {
  const rows = await driver.query<{ total: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM item_stock WHERE item_id = ?;',
    [itemId],
  );
  return Number(rows[0]!.total);
}

describe('applying a location tombstone re-homes stock without doubling it (issue #709)', () => {
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

  it('keeps the quantity the peer re-homed, rather than adding this device’s shelf row to it', async () => {
    const shelf = await a.locations.create({ name: 'Shelf' });
    const item = await a.items.create({ name: 'Widget', quantity: 5, locationId: shelf.id });

    await runSync(a.driver, provider, NO_QUOTA); // A publishes
    await runSync(b.driver, provider, NO_QUOTA); // B clones — both hold Shelf: 5

    expect(await stockSum(b.driver, item.id)).toBe(5);

    // A removes the shelf. Its own re-home moves the five units to Unassigned.
    await a.locations.delete(shelf.id);
    expect(await stockSum(a.driver, item.id)).toBe(5);

    await runSync(a.driver, provider, NO_QUOTA); // A pushes the tombstone + its Unassigned row
    await runSync(b.driver, provider, NO_QUOTA); // B merges it

    expect(await stockSum(b.driver, item.id)).toBe(5);
    expect((await b.items.getById(item.id))!.quantity).toBe(5);
  });

  it('still re-homes a batch the peer snapshot does not account for', async () => {
    const shelf = await a.locations.create({ name: 'Shelf' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // B stocks an item at the shelf that A never sees, while A removes the shelf.
    const item = await b.items.create({ name: 'Bolt', quantity: 7, locationId: shelf.id });
    await a.locations.delete(shelf.id);

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await stockSum(b.driver, item.id)).toBe(7);
    expect((await b.items.getById(item.id))!.quantity).toBe(7);
  });

  /**
   * A characterisation test, not a statement of the desired figure. The peer's re-homed
   * placement wins Last-Write-Wins outright, so a quantity this device added to the same lot
   * while the peer was offline is discarded. The truthful answer is 8; recovering it needs the
   * re-home to be reconcilable through the stock-delta ledger, which the duplicate-delta-id
   * problem (issue #696) still blocks. Pinned here so the trade-off cannot change unnoticed.
   */
  it('lets the peer’s re-homed figure win a lot this device also changed offline', async () => {
    const shelf = await a.locations.create({ name: 'Shelf' });
    const item = await a.items.create({ name: 'Widget', quantity: 5, locationId: shelf.id });

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    await b.items.adjustQuantity(item.id, 3); // B: Shelf 8
    await a.locations.delete(shelf.id); // A: Unassigned 5

    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await stockSum(b.driver, item.id)).toBe(5);
    expect((await b.items.getById(item.id))!.quantity).toBe(5);
  });
});
