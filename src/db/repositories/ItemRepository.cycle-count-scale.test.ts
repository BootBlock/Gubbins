import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Cycle counting a **bulk** location (issue #561).
 *
 * A location's count is deliberately uncapped — capping it is how an audit under-counts — so
 * every step downstream of the count has to cost something better than "once per item at the
 * location". These are the two reads that did not: the presence audit, which used to page the
 * location's whole item set and filter it in JS, and the reconciliation plan, which used to
 * await two or three round-trips per adjusted line.
 */
describe('ItemRepository — cycle counting a bulk location (issue #561)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('listSerialisedAtLocation', () => {
    it('returns the location’s active SERIALISED instances and nothing else', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const other = await locations.create({ name: 'Shelf B' });

      const [kept, retired] = await items.createSerialised({
        name: 'Multimeter',
        trackingMode: 'SERIALISED',
        count: 2,
        locationId: shelf.id,
      });
      await items.softDelete(retired!.id);
      // Neither of these belongs on the presence audit: one is bulk stock at the same shelf,
      // the other is a serialised instance somewhere else entirely.
      await items.create({ name: 'Washers', quantity: 500, locationId: shelf.id });
      await items.create({ name: 'Scope', trackingMode: 'SERIALISED', locationId: other.id });

      const audit = await items.listSerialisedAtLocation(shelf.id);
      expect(audit).toEqual([{ itemId: kept!.id, name: 'Multimeter', serialNo: 1 }]);
    });

    it('orders by name, then by serial number', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      await items.createSerialised({
        name: 'Zeta gauge',
        trackingMode: 'SERIALISED',
        count: 2,
        locationId: shelf.id,
      });
      await items.createSerialised({
        name: 'Alpha probe',
        trackingMode: 'SERIALISED',
        count: 2,
        locationId: shelf.id,
      });

      const audit = await items.listSerialisedAtLocation(shelf.id);
      expect(audit.map((line) => `${line.name} #${line.serialNo}`)).toEqual([
        'Alpha probe #1',
        'Alpha probe #2',
        'Zeta gauge #1',
        'Zeta gauge #2',
      ]);
    });

    it('is not capped, and reads the location once rather than page by page', async () => {
      const shelf = await locations.create({ name: 'Bulk store' });
      // Past the 200-row page the caller-side walk used, so a re-introduced `LIMIT` — or a
      // paging loop that stops early — shows up here as a short audit rather than in the field
      // as an under-count.
      await items.createSerialised({
        name: 'Sensor',
        trackingMode: 'SERIALISED',
        count: 250,
        locationId: shelf.id,
      });

      const counting = countingDriver(driver);
      const audit = await new ItemRepository(counting.driver).listSerialisedAtLocation(shelf.id);

      expect(audit).toHaveLength(250);
      expect(counting.reads()).toBe(1);
    });
  });

  describe('authoriseCount', () => {
    it('costs the same number of reads however many lines the count has', async () => {
      // The assertion that matters is not a number but a *shape*: authorising must not grow a
      // read per adjusted line, which is what two or three sequential reads per adjustment did.
      // Counting the same shelf at two very different sizes states that directly, and cannot be
      // satisfied by a bound that happens to be generous.
      const small = await countAtSize(5);
      const large = await countAtSize(60);
      expect(large.reads).toBe(small.reads);
      expect(small.reconciled).toBe(5);
      expect(large.reconciled).toBe(60);

      /** Reconcile a fresh shelf of `n` drifted lines, reporting the reads it took. */
      async function countAtSize(n: number): Promise<{ reads: number; reconciled: number }> {
        const shelf = await locations.create({ name: `Bulk store ${n}` });
        const lines = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            items.create({ name: `Part ${n}-${i}`, quantity: 10, locationId: shelf.id }),
          ),
        );

        const counting = countingDriver(driver);
        const result = await new ItemRepository(counting.driver).authoriseCount({
          locationId: shelf.id,
          quantityAdjustments: lines.map((item) => ({
            itemId: item.id,
            counted: 7,
            locationName: `Bulk store ${n}`,
            locationId: shelf.id,
            batch: { batchNumber: null, lotNumber: null, expiryDate: null },
          })),
          serialisedAdjustments: [],
        });

        for (const item of result.discrete) expect(item.quantity).toBe(7);
        return { reads: counting.reads(), reconciled: result.discrete.length };
      }
    });

    it('still refuses a count naming an item that no longer exists', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      await expect(
        items.authoriseCount({
          locationId: shelf.id,
          quantityAdjustments: [
            { itemId: 'gone', counted: 1, locationName: 'Shelf A', locationId: shelf.id },
          ],
          serialisedAdjustments: [],
        }),
      ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT', message: 'Item "gone" does not exist.' });
    });

    it('still refuses a presence audit naming an item that no longer exists', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      await expect(
        items.authoriseCount({
          locationId: shelf.id,
          quantityAdjustments: [],
          serialisedAdjustments: [{ itemId: 'gone', note: 'Not found' }],
        }),
      ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT', message: 'Item "gone" does not exist.' });
    });
  });
});

/** A pass-through driver that counts the reads made through it. */
function countingDriver(inner: IDatabaseDriver): { driver: IDatabaseDriver; reads: () => number } {
  let reads = 0;
  const driver: IDatabaseDriver = {
    ...inner,
    query: (sql, params) => {
      reads += 1;
      return inner.query(sql, params);
    },
    queryOne: (sql, params) => {
      reads += 1;
      return inner.queryOne(sql, params);
    },
  };
  return { driver, reads: () => reads };
}
