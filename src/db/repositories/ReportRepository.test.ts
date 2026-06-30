import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MS_PER_DAY, UNASSIGNED_LOCATION_ID } from './constants';
import { CategoryRepository } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ReportRepository } from './ReportRepository';
import { SupplierPartRepository } from './SupplierPartRepository';

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
  let supplierParts: SupplierPartRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    locations = new LocationRepository(driver);
    reports = new ReportRepository(driver);
    supplierParts = new SupplierPartRepository(driver);
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

    it('values an item with no manual cost at its preferred supplier cost (Phase-60 precedence)', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      // No manual unitCost: valuation must fall back to the preferred supplier part's cost.
      const item = await items.create({ name: 'Relay', locationId: shelf.id, quantity: 10, unitCost: null });
      await supplierParts.create(item.id, { supplierName: 'Cheap Co', unitCost: 5 });
      await supplierParts.create(item.id, { supplierName: 'Preferred Co', unitCost: 7, isPreferred: true });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(70); // 10 × £7 (the *preferred* part, not the cheaper one)
      expect(report.unpricedItemCount).toBe(0);
      const shelfGroup = report.byLocation.find((g) => g.id === shelf.id);
      expect(shelfGroup).toMatchObject({ value: 70 });
    });

    it('lets a manual unitCost win over the preferred supplier cost', async () => {
      const item = await items.create({ name: 'Switch', quantity: 4, unitCost: 2 });
      await supplierParts.create(item.id, { supplierName: 'Preferred Co', unitCost: 99, isPreferred: true });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(8); // 4 × £2 manual, not £99
    });

    it('values dead stock at the preferred supplier cost when unpriced manually', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'OldFan', quantity: 3, unitCost: null });
      await supplierParts.create(item.id, { supplierName: 'Preferred Co', unitCost: 6, isPreferred: true });
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [now - 120 * MS_PER_DAY, item.id]);

      const report = await reports.deadStock(30, now);
      expect(report.lines.map((l) => l.name)).toEqual(['OldFan']);
      expect(report.totalValue).toBe(18); // 3 × £6 preferred supplier cost
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

  // Phase 65 — reorder shortfall + plan ------------------------------------------
  describe('listReorderShortfall (Phase 65)', () => {
    it('returns an empty array when no items are below their reorder point', async () => {
      await items.create({ name: 'Plentiful', quantity: 100 });
      const rows = await reports.listReorderShortfall();
      expect(rows).toHaveLength(0);
    });

    it('includes DISCRETE items at or below the effective reorder point', async () => {
      await items.create({ name: 'Low', quantity: 2 }); // below default threshold (5)
      await items.create({ name: 'OK', quantity: 50 });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemName).toBe('Low');
      // shortfall = max(0, 5 - 2) = 3
      expect(rows[0]!.shortfall).toBe(3);
    });

    it('uses per-item reorderPoint when set, ignoring the global default', async () => {
      // The item has a bespoke floor of 20; global default is 5 → it is low vs its own floor.
      const item = await items.create({ name: 'HighFloor', quantity: 10, reorderPoint: 20 });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      expect(rows.some((r) => r.itemId === item.id)).toBe(true);
      const row = rows.find((r) => r.itemId === item.id)!;
      // shortfall = 20 - 10 = 10
      expect(row.shortfall).toBe(10);
    });

    it('uses per-item reorderQty when set (explicit top-up amount)', async () => {
      // reorderQty=15 overrides the shortfall-to-floor calculation
      const item = await items.create({
        name: 'CustomTopUp',
        quantity: 1,
        reorderPoint: 5,
        reorderQty: 15,
      });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      const row = rows.find((r) => r.itemId === item.id)!;
      expect(row.shortfall).toBe(15); // reorderQty wins
    });

    it('joins the preferred supplier part when one is marked', async () => {
      const item = await items.create({ name: 'Chip', quantity: 0 });
      await supplierParts.create(item.id, { supplierName: 'Non-preferred', unitCost: 1 });
      await supplierParts.create(item.id, {
        supplierName: 'DigiKey',
        unitCost: 0.5,
        packQty: 10,
        minOrderQty: 5,
        isPreferred: true,
      });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      const row = rows.find((r) => r.itemId === item.id)!;
      expect(row.preferredSupplier).not.toBeNull();
      expect(row.preferredSupplier!.supplierName).toBe('DigiKey');
      expect(row.preferredSupplier!.unitCost).toBe(0.5);
      expect(row.preferredSupplier!.packQty).toBe(10);
      expect(row.preferredSupplier!.minOrderQty).toBe(5);
    });

    it('returns null preferredSupplier when no supplier part is marked preferred', async () => {
      const item = await items.create({ name: 'NoPreferred', quantity: 0 });
      await supplierParts.create(item.id, { supplierName: 'Some Supplier', unitCost: 1 });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      const row = rows.find((r) => r.itemId === item.id)!;
      expect(row.preferredSupplier).toBeNull();
    });

    it('excludes inactive items and abstract variant parents', async () => {
      const parent = await items.create({ name: 'Parent', quantity: 0 });
      await items.createVariant(parent.id, { name: 'Variant' });
      const removed = await items.create({ name: 'Removed', quantity: 0 });
      await items.softDelete(removed.id);

      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      expect(rows.every((r) => r.itemName !== 'Parent')).toBe(true);
      expect(rows.every((r) => r.itemName !== 'Removed')).toBe(true);
    });
  });

  describe('reorderPlan (Phase 65)', () => {
    it('delegates to buildReorderPlan, producing correct supplier groups', async () => {
      const r1 = await items.create({ name: 'R1', quantity: 0 });
      const r2 = await items.create({ name: 'R2', quantity: 1 });
      await supplierParts.create(r1.id, { supplierName: 'DigiKey', unitCost: 0.1, isPreferred: true });
      // r2 has no preferred supplier → goes to Unassigned.

      const plan = await reports.reorderPlan({ qtyThreshold: 5 });
      const dk = plan.find((g) => g.supplierName === 'DigiKey');
      const ua = plan.find((g) => g.supplierName === 'Unassigned');
      expect(dk).toBeDefined();
      expect(ua).toBeDefined();
      // DigiKey sorts before Unassigned.
      expect(plan[0]!.supplierName).toBe('DigiKey');
    });
  });
});
