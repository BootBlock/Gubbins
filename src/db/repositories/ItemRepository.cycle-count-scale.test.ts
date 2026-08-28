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
    it('plans a many-line count with a bounded number of reads', async () => {
      const shelf = await locations.create({ name: 'Bulk store' });
      const lines = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          items.create({ name: `Part ${i}`, quantity: 10, locationId: shelf.id }),
        ),
      );

      const counting = countingDriver(driver);
      const result = await new ItemRepository(counting.driver).authoriseCount({
        locationId: shelf.id,
        quantityAdjustments: lines.map((item) => ({
          itemId: item.id,
          counted: 7,
          locationName: 'Bulk store',
          locationId: shelf.id,
          batch: { batchNumber: null, lotNumber: null, expiryDate: null },
        })),
        serialisedAdjustments: [],
      });

      expect(result.discrete).toHaveLength(30);
      for (const item of result.discrete) expect(item.quantity).toBe(7);
      // Planning is three reads (the items, their lots, the system-location check) plus one
      // `getById` per written item to report the result. The point of the assertion is the
      // *shape*: it must not grow with the number of lines beyond that per-result read, which
      // is what two or three sequential reads per adjustment used to do.
      expect(counting.reads()).toBeLessThan(2 * lines.length);
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
