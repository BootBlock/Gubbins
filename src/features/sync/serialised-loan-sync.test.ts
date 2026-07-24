import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CheckoutRepository, ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #193 — a SERIALISED item is one physical instance, so it can be on loan to at most one
 * borrower. The local pre-flight guard stops a second loan on one device, but two devices offline
 * can each pass it, and the id-keyed LWW union would otherwise keep both open loans. This proves
 * the merge collapses that end-to-end: after convergence exactly one loan stays open, both devices
 * agree on which, the repair does not churn, and returning the survivor clears the item.
 */
async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  checkouts: CheckoutRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    checkouts: new CheckoutRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

/** The open loans of an item on a device, by checkout id. */
async function openLoanIds(
  device: Awaited<ReturnType<typeof makeDevice>>,
  itemId: string,
): Promise<string[]> {
  const page = await device.checkouts.listOpen({ limit: 100 });
  return page.rows
    .filter((r) => r.itemId === itemId)
    .map((r) => r.id)
    .sort();
}

describe('issue #193 — serialised item double-booked across two offline devices', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;
  let itemId: string;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();

    // A creates the serialised asset and both devices sync so each holds it before going offline.
    const [asset] = await a.items.createSerialised({ name: 'Cordless drill', trackingMode: 'SERIALISED' });
    itemId = asset!.id;
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('keeps exactly one open loan, agreed by both devices, and does not churn', async () => {
    // Offline: each device lends the same physical instance to a different contact.
    await a.checkouts.checkout({ itemId, contactName: 'Ada' });
    await b.checkouts.checkout({ itemId, contactName: 'Grace' });

    // A publishes its loan; B pulls it and now holds two open loans → the merge closes one.
    await runSync(a.driver, provider, NO_QUOTA);
    const onB = await runSync(b.driver, provider, NO_QUOTA);
    expect(onB.serialisedLoansClosed).toBe(1);

    // A pulls B's converged state: the loser already arrives closed, so A closes nothing itself.
    const onA = await runSync(a.driver, provider, NO_QUOTA);
    expect(onA.serialisedLoansClosed).toBe(0);

    const survivorsA = await openLoanIds(a, itemId);
    const survivorsB = await openLoanIds(b, itemId);
    expect(survivorsA).toHaveLength(1);
    expect(survivorsB).toEqual(survivorsA); // both devices kept the same loan

    // Re-syncing settles with no further repair and no churn (the loser stays closed).
    expect((await runSync(a.driver, provider, NO_QUOTA)).serialisedLoansClosed).toBe(0);
    expect((await runSync(b.driver, provider, NO_QUOTA)).serialisedLoansClosed).toBe(0);
    expect(await openLoanIds(a, itemId)).toEqual(survivorsA);
    expect(await openLoanIds(b, itemId)).toEqual(survivorsA);
  });

  it('returning the surviving loan then clears the item on both devices', async () => {
    await a.checkouts.checkout({ itemId, contactName: 'Ada' });
    await b.checkouts.checkout({ itemId, contactName: 'Grace' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    // Return the one loan that survived — the item must then read as not on loan everywhere.
    const [survivorId] = await openLoanIds(a, itemId);
    await a.checkouts.checkIn(survivorId!);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await openLoanIds(a, itemId)).toEqual([]);
    expect(await openLoanIds(b, itemId)).toEqual([]);
  });
});
