import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MS_PER_DAY, UNASSIGNED_LOCATION_ID } from './constants';
import { CategoryRepository } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ReportRepository } from './ReportRepository';

/**
 * ReportRepository — read-only §3 valuation/consumption/movement/low-stock/dead-stock
 * aggregations over data already stored (no schema change). The pure bucketing/grouping
 * maths is unit-tested in `@/features/reports/reports`; these tests prove the SQL feeds it
 * the right rows over `:memory:` fixtures.
 */
describe('ReportRepository', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let locations: LocationRepository;
  let reports: ReportRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    locations = new LocationRepository(driver);
    reports = new ReportRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('inventoryValue', () => {
    it('totals value, counts unpriced items, and groups by category and location', async () => {
      const caps = await categories.create({ name: 'Capacitors' });
      const shelf = await locations.create({ name: 'Shelf A' });

      await items.create({ name: 'Cap', categoryId: caps.id, locationId: shelf.id, quantity: 10, unitCost: 2 });
      await items.create({ name: 'Resistor', locationId: shelf.id, quantity: 100, unitCost: 1 });
      await items.create({ name: 'Mystery', quantity: 5, unitCost: null }); // unpriced

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(120); // 10*2 + 100*1
      expect(report.totalQuantity).toBe(115);
      expect(report.unpricedItemCount).toBe(1);

      // Category breakdown: Capacitors (£20) then Ungrouped (£100, forced last).
      expect(report.byCategory.map((g) => [g.name, g.value])).toEqual([
        ['Capacitors', 20],
        ['Ungrouped', 100],
      ]);

      // Location breakdown: Shelf A holds the priced stock (£120); Unassigned holds the
      // unpriced Mystery (£0).
      const shelfGroup = report.byLocation.find((g) => g.id === shelf.id);
      expect(shelfGroup).toMatchObject({ value: 120, quantity: 110 });
      const unassigned = report.byLocation.find((g) => g.id === UNASSIGNED_LOCATION_ID);
      expect(unassigned).toMatchObject({ value: 0, quantity: 5 });
    });

    it('excludes inactive items and abstract variant parents from valuation', async () => {
      const parent = await items.create({ name: 'Drill', trackingMode: 'SERIALISED' });
      // A child variant gives the parent children, making it an abstract parent.
      await items.createVariant(parent.id, { name: 'Drill v2' });
      const removed = await items.create({ name: 'Gone', quantity: 9, unitCost: 5 });
      await items.softDelete(removed.id);

      const report = await reports.inventoryValue();
      // Neither the soft-deleted item nor the abstract parent contribute.
      expect(report.totalValue).toBe(0);
    });
  });

  describe('consumptionRate', () => {
    it('sums negative quantity deltas within the window and derives a daily rate', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Screws', quantity: 100 });
      // Two consumption events inside a 10-day window: -30 and -20 → 50 over 10 days = 5/day.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
         VALUES (?, ?, 'QUANTITY_CHANGE', ?, ?), (?, ?, 'QUANTITY_CHANGE', ?, ?);`,
        [
          crypto.randomUUID(), item.id, -30, now - 5 * MS_PER_DAY,
          crypto.randomUUID(), item.id, -20, now - 2 * MS_PER_DAY,
        ],
      );
      // A positive (incoming) delta must not count toward consumption.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at) VALUES (?, ?, 'RECEIVED', 40, ?);`,
        [crypto.randomUUID(), item.id, now - 3 * MS_PER_DAY],
      );

      const report = await reports.consumptionRate(10, now);
      expect(report.totalConsumed).toBe(50);
      expect(report.windowDays).toBe(10);
      expect(report.perDay).toBe(5);
    });
  });

  describe('movement', () => {
    it('buckets signed quantity deltas into ins and outs over the window', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Bolts', quantity: 0 });
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
         VALUES (?, ?, 'RECEIVED', 50, ?), (?, ?, 'QUANTITY_CHANGE', -10, ?);`,
        [
          crypto.randomUUID(), item.id, now - 6 * MS_PER_DAY,
          crypto.randomUUID(), item.id, now - 1 * MS_PER_DAY,
        ],
      );

      const report = await reports.movement(7, 7, now);
      expect(report.buckets).toHaveLength(7);
      expect(report.totalIn).toBe(50);
      expect(report.totalOut).toBe(10);
    });
  });

  describe('lowStockCount', () => {
    it('counts active low items by the same predicate as listLowStock', async () => {
      await items.create({ name: 'LowQty', quantity: 2 });
      await items.create({ name: 'Plenty', quantity: 50 });
      await items.create({
        name: 'LowResin',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 100 }, // 10%
      });
      expect(await reports.lowStockCount()).toBe(2);
    });
  });

  describe('deadStock', () => {
    it('lists items with no movement in N days, tying up their value', async () => {
      const now = Date.now();
      const idle = await items.create({ name: 'Idle', quantity: 4, unitCost: 5 });
      const moved = await items.create({ name: 'Moved', quantity: 4, unitCost: 5 });

      // Backdate the idle item's creation well past the cutoff; it has no movement history.
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [now - 120 * MS_PER_DAY, idle.id]);
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [now - 120 * MS_PER_DAY, moved.id]);
      // The "moved" item moved yesterday → not dead.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at) VALUES (?, ?, 'QUANTITY_CHANGE', -1, ?);`,
        [crypto.randomUUID(), moved.id, now - 1 * MS_PER_DAY],
      );

      const report = await reports.deadStock(30, now);
      expect(report.lines.map((l) => l.name)).toEqual(['Idle']);
      expect(report.totalValue).toBe(20); // 4 * £5
      expect(report.lines[0]?.idleDays).toBe(120);
    });
  });
});
