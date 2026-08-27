import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #539 — a kit cannot contain itself, directly or transitively. `addKitComponent` enforces
 * that with a descendant walk before it writes, but that is a read-then-write check across sibling
 * rows, so two offline devices can each make a locally valid nesting move whose merge closes the
 * loop: X contains Y and Y contains X. Reading such a kit used to overflow the stack in the
 * database worker, and the offending link could not be removed because the screen that would show
 * it was the one that crashed. This proves the merge repairs it end-to-end: both devices converge
 * on the same acyclic graph, the kit reads normally afterwards, and re-syncing does not churn.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

/** Every kit link on a device as `kit>component` pairs, sorted — the whole graph, comparably. */
async function links(
  device: Awaited<ReturnType<typeof makeDevice>>,
  kitIds: readonly string[],
): Promise<string[]> {
  const pairs: string[] = [];
  for (const kitId of kitIds) {
    for (const c of await device.items.listKitComponents(kitId)) {
      pairs.push(`${kitId}>${c.componentItemId}`);
    }
  }
  return pairs.sort();
}

describe('issue #539 — two devices nest the same pair of kits inside each other', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;
  let x: string;
  let y: string;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();

    // A creates both kits and both devices sync, so each holds them before going offline.
    x = (await a.items.create({ name: 'Kit X', quantity: 0 })).id;
    y = (await a.items.create({ name: 'Kit Y', quantity: 0 })).id;
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('keeps one link of the loop, agreed by both devices, and the kit reads normally after', async () => {
    // Offline, each nesting move passes its own device's guard: neither can see the other.
    await a.items.addKitComponent(x, y, 1);
    await b.items.addKitComponent(y, x, 1);
    // Age A's link by a minute so it is unambiguously the one made first. Both are created in the
    // same millisecond here, which would leave the winner to the id tie-break — deterministic, but
    // not the rule the wiki tells users to expect.
    await a.driver.execute(
      'UPDATE kit_components SET created_at = created_at - 60000 WHERE kit_item_id = ?;',
      [x],
    );

    // A publishes; B pulls and now holds both directions → the merge breaks the loop.
    await runSync(a.driver, provider, NO_QUOTA);
    const onB = await runSync(b.driver, provider, NO_QUOTA);
    expect(onB.kitLinksBroken).toBe(1);

    // A pulls B's converged state: the removal arrives as a tombstone, so A breaks nothing itself.
    const onA = await runSync(a.driver, provider, NO_QUOTA);
    expect(onA.kitLinksBroken).toBe(0);

    // The link made first is the one that stands, on both devices — the promise the wiki makes.
    const onDeviceA = await links(a, [x, y]);
    const onDeviceB = await links(b, [x, y]);
    expect(onDeviceA).toEqual([`${x}>${y}`]);
    expect(onDeviceB).toEqual(onDeviceA);

    // The whole point: the surviving kit is readable again rather than taking the worker down.
    await expect(a.items.rollUpAvailability(x)).resolves.toMatchObject({ count: 0 });
    await expect(b.items.rollUpAvailability(y)).resolves.toMatchObject({ count: 0 });

    // Re-syncing settles with no further repair and no churn — the removal does not come back.
    expect((await runSync(a.driver, provider, NO_QUOTA)).kitLinksBroken).toBe(0);
    expect((await runSync(b.driver, provider, NO_QUOTA)).kitLinksBroken).toBe(0);
    expect(await links(a, [x, y])).toEqual(onDeviceA);
    expect(await links(b, [x, y])).toEqual(onDeviceA);
  });

  it('leaves an ordinary nesting made on two devices alone', async () => {
    // Both moves point the same way down the graph, so nothing loops and nothing is removed.
    const z = (await a.items.create({ name: 'Kit Z', quantity: 0 })).id;
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    await a.items.addKitComponent(x, y, 1);
    await b.items.addKitComponent(y, z, 2);

    await runSync(a.driver, provider, NO_QUOTA);
    const onB = await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const both = [`${x}>${y}`, `${y}>${z}`].sort(); // `links` sorts, and the ids are random UUIDs
    expect(onB.kitLinksBroken).toBe(0);
    expect(await links(a, [x, y, z])).toEqual(both);
    expect(await links(b, [x, y, z])).toEqual(both);
  });
});
