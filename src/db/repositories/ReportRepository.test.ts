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

      await items.create({
        name: 'Cap',
        categoryId: caps.id,
        locationId: shelf.id,
        quantity: 10,
        unitCost: 2,
      });
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
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 120 * MS_PER_DAY,
        item.id,
      ]);

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
          crypto.randomUUID(),
          item.id,
          -30,
          now - 5 * MS_PER_DAY,
          crypto.randomUUID(),
          item.id,
          -20,
          now - 2 * MS_PER_DAY,
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
          crypto.randomUUID(),
          item.id,
          now - 6 * MS_PER_DAY,
          crypto.randomUUID(),
          item.id,
          now - 1 * MS_PER_DAY,
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
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 120 * MS_PER_DAY,
        idle.id,
      ]);
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 120 * MS_PER_DAY,
        moved.id,
      ]);
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
      await items.create({ name: 'R2', quantity: 1 });
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

  // Phase 74 — advanced analytics -----------------------------------------------
  /** Insert one append-only consumption/movement ledger row. */
  async function addHistory(itemId: string, delta: number, at: number): Promise<void> {
    await driver.execute(
      `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
       VALUES (?, ?, 'QUANTITY_CHANGE', ?, ?);`,
      [crypto.randomUUID(), itemId, delta, at],
    );
  }

  describe('abcAnalysis (Phase 74)', () => {
    it('values annual consumption (units × cost) and classifies the consuming head as A', async () => {
      const now = Date.now();
      const big = await items.create({ name: 'BigUser', quantity: 100, unitCost: 3 });
      const idle = await items.create({ name: 'Idle', quantity: 100, unitCost: 3 });
      // BigUser consumed 10 units inside the annual window → annualValue 30; a positive
      // (inbound) delta must not count toward consumption.
      await addHistory(big.id, -10, now - 30 * MS_PER_DAY);
      await addHistory(big.id, 5, now - 20 * MS_PER_DAY);
      // A consumption far outside the 365-day window is excluded.
      await addHistory(idle.id, -50, now - 400 * MS_PER_DAY);

      const report = await reports.abcAnalysis(365, now);
      const bigLine = report.lines.find((l) => l.id === big.id)!;
      const idleLine = report.lines.find((l) => l.id === idle.id)!;
      expect(bigLine.annualValue).toBe(30); // 10 × £3
      expect(bigLine.tier).toBe('A');
      expect(idleLine.annualValue).toBe(0); // out-of-window consumption ignored
      expect(idleLine.tier).toBe('C');
      expect(report.totalValue).toBe(30);
    });
  });

  describe('turnover (Phase 74)', () => {
    it('reconstructs the window-start holding and derives the turnover ratio', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Cycler', quantity: 10, unitCost: 2 });
      // Inside a 30-day window: consume 40, receive 20 → consumed 40, netDelta −20.
      await addHistory(item.id, -40, now - 10 * MS_PER_DAY);
      await addHistory(item.id, 20, now - 5 * MS_PER_DAY);

      const report = await reports.turnover(30, now);
      const line = report.lines.find((l) => l.id === item.id)!;
      // startQty = 10 − (−20) = 30; avgQty = 20; avgValue = £40; cogs = 40 × £2 = £80.
      expect(line.cogs).toBe(80);
      expect(line.avgValue).toBe(40);
      expect(line.turnover).toBe(2); // 80 / 40
      expect(report.turnover).toBe(2);
    });
  });

  describe('stockAging (Phase 74)', () => {
    it('ages stock by newest inbound, falling back to acquired_at then creation', async () => {
      const now = Date.now();
      const fresh = await items.create({ name: 'Fresh', quantity: 5, unitCost: 1 });
      const old = await items.create({ name: 'Old', quantity: 5, unitCost: 1 });
      const acquired = await items.create({ name: 'Acquired', quantity: 5, unitCost: 1 });

      // Fresh: an inbound 10 days ago → 0–30 bucket (wins over its creation date).
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 200 * MS_PER_DAY,
        fresh.id,
      ]);
      await addHistory(fresh.id, 5, now - 10 * MS_PER_DAY);
      // Old: no inbound, created 120 days ago → 91–180 bucket.
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [now - 120 * MS_PER_DAY, old.id]);
      // Acquired: acquired_at 60 days ago overrides a recent creation → 31–90 bucket.
      const acquiredIso = new Date(now - 60 * MS_PER_DAY).toISOString();
      await driver.execute('UPDATE items SET acquired_at = ? WHERE id = ?;', [acquiredIso, acquired.id]);

      const report = await reports.stockAging(now);
      const byLabel = Object.fromEntries(report.buckets.map((b) => [b.label, b.itemCount]));
      expect(byLabel['0–30 days']).toBe(1); // Fresh
      expect(byLabel['31–90 days']).toBe(1); // Acquired
      expect(byLabel['91–180 days']).toBe(1); // Old
      expect(report.totalQuantity).toBe(15);
      expect(report.totalValue).toBe(15);
    });
  });

  describe('valuationTrend (Phase 74)', () => {
    it('reconstructs total value backward from the current value over the window', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Widget', quantity: 10, unitCost: 2 });
      // Current value = 10 × £2 = £20. A −5 consumption (value −£10) happened mid-window,
      // so the inventory was worth £30 before it.
      await addHistory(item.id, -5, now - 15 * MS_PER_DAY);

      const report = await reports.valuationTrend(30, 4, now);
      expect(report.points).toHaveLength(4);
      expect(report.endValue).toBe(20); // equals the current value
      expect(report.startValue).toBe(30); // higher before the consumption
      expect(report.changeValue).toBe(-10);
    });
  });

  describe('dataHygiene', () => {
    const sampleIds = (report: Awaited<ReturnType<ReportRepository['dataHygiene']>>, kind: string) =>
      report.sections.find((s) => s.kind === kind)!.samples.map((s) => s.id);
    const countFor = (report: Awaited<ReturnType<ReportRepository['dataHygiene']>>, kind: string) =>
      report.sections.find((s) => s.kind === kind)!.count;

    it('flags each quality issue over real SQL and leaves a tidy item unflagged', async () => {
      const cat = await categories.create({ name: 'Capacitors' });
      const shelf = await locations.create({ name: 'Shelf A' });

      // Tidy: categorised, real location, priced, photographed, cycle-counted.
      const tidy = await items.create({
        name: 'Tidy',
        categoryId: cat.id,
        locationId: shelf.id,
        quantity: 1,
        unitCost: 2,
      });
      await driver.execute('INSERT INTO item_images (id, item_id, full_res_opfs_path) VALUES (?, ?, ?);', [
        crypto.randomUUID(),
        tidy.id,
        'images/tidy.jpg',
      ]);
      await driver.execute("INSERT INTO item_history (id, item_id, action) VALUES (?, ?, 'RECONCILED');", [
        crypto.randomUUID(),
        tidy.id,
      ]);

      const noCat = await items.create({ name: 'NoCat', locationId: shelf.id, quantity: 1, unitCost: 2 });
      // Unassigned: omit locationId so it lands in the holding pen.
      const unassigned = await items.create({
        name: 'Homeless',
        categoryId: cat.id,
        quantity: 1,
        unitCost: 2,
      });
      const unpriced = await items.create({
        name: 'Unpriced',
        categoryId: cat.id,
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
      });

      // Two items sharing an MPN (case/space-insensitively) — possible duplicates. The first
      // is unpriced manually but carries a preferred supplier cost, so it must NOT be flagged
      // as missing-price (exercises preferredSupplierCostSql).
      const dupA = await items.create({
        name: 'DupA',
        categoryId: cat.id,
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
        mpn: 'NE555P',
      });
      await supplierParts.create(dupA.id, { supplierName: 'Pref Co', unitCost: 0.5, isPreferred: true });
      const dupB = await items.create({
        name: 'DupB',
        categoryId: cat.id,
        locationId: shelf.id,
        quantity: 1,
        unitCost: 2,
        mpn: ' ne555p ',
      });

      const report = await reports.dataHygiene(180);

      expect(report.totalItems).toBe(6);
      expect(sampleIds(report, 'missing-category')).toEqual([noCat.id]);
      expect(sampleIds(report, 'missing-location')).toEqual([unassigned.id]);
      expect(sampleIds(report, 'missing-price')).toEqual([unpriced.id]); // dupA saved by supplier cost
      expect(new Set(sampleIds(report, 'duplicate-mpn'))).toEqual(new Set([dupA.id, dupB.id]));

      // Only Tidy has a photo / a reconciliation, so the other five are flagged for each.
      expect(countFor(report, 'missing-photo')).toBe(5);
      expect(sampleIds(report, 'missing-photo')).not.toContain(tidy.id);
      expect(countFor(report, 'never-counted')).toBe(5);
      expect(sampleIds(report, 'never-counted')).not.toContain(tidy.id);

      // Tidy clears every check; the other five each fail at least one.
      expect(report.flaggedItems).toBe(5);
      expect(sampleIds(report, 'stale')).toEqual([]); // everything is freshly created
    });

    it('flags a long-idle item as stale (lastActivity falls back to created_at)', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const item = await items.create({ name: 'Forgotten', locationId: shelf.id, quantity: 1, unitCost: 1 });
      const now = Date.now();
      const old = now - 200 * MS_PER_DAY;
      // The ledger is immutable (append-only), so drop the CREATED row and backdate the item:
      // with no history, lastActivityAt falls back to the (now-old) created_at.
      await driver.execute('DELETE FROM item_history WHERE item_id = ?;', [item.id]);
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [old, item.id]);

      const report = await reports.dataHygiene(180, now);
      expect(report.sections.find((s) => s.kind === 'stale')!.samples.map((s) => s.id)).toContain(item.id);
    });

    it('excludes inactive items and abstract variant parents', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const removed = await items.create({ name: 'Removed', locationId: shelf.id, quantity: 1, unitCost: 1 });
      await items.softDelete(removed.id);

      const parent = await items.create({ name: 'Resistor', locationId: shelf.id });
      await items.createVariant(parent.id, { name: '10k', quantity: 5 });

      const report = await reports.dataHygiene(180);
      const everyId = new Set(report.sections.flatMap((s) => s.samples.map((x) => x.id)));
      expect(everyId.has(removed.id)).toBe(false); // inactive — excluded
      expect(everyId.has(parent.id)).toBe(false); // abstract variant parent — excluded
    });
  });

  describe('spendAnalytics (Phase 79)', () => {
    // A fixed wall clock so the trailing window and the acquisition date are deterministic.
    const NOW = Date.UTC(2026, 5, 15, 12);
    const day = (n: number) => NOW + n * MS_PER_DAY;

    it('composes spend from PO lines, project expenses and acquisitions, tagged by source', async () => {
      // Category shared by the PO-line item and the acquisition.
      await driver.execute("INSERT INTO categories (id, name) VALUES ('cat-r', 'Resistors');");
      // An acquired asset: purchase_price 500 on 2026-06-10 (inside the 90-day window).
      await driver.execute(
        `INSERT INTO items (id, name, location_id, category_id, quantity, purchase_price, acquired_at)
         VALUES ('it-1', 'Scope', ?, 'cat-r', 1, 500, '2026-06-10');`,
        [UNASSIGNED_LOCATION_ID],
      );
      // A received PO line: 5 received @ £2 = £10 from supplier "RS", ordered 5 days ago.
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_name, status, ordered_at) VALUES ('po-1', 'RS', 'RECEIVED', ?);",
        [day(-5)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-1', 'po-1', 'it-1', 5, 5, 2);`,
      );
      // A manual project expense: £30, incurred 3 days ago.
      await driver.execute("INSERT INTO projects (id, name) VALUES ('pr-1', 'Build');");
      await driver.execute(
        "INSERT INTO project_expenses (id, project_id, amount, incurred_at) VALUES ('ex-1', 'pr-1', 30, ?);",
        [day(-3)],
      );
      // An OUT-OF-WINDOW received PO (400 days ago) — must be excluded.
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_name, status, ordered_at) VALUES ('po-old', 'Old', 'RECEIVED', ?);",
        [day(-400)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-old', 'po-old', 'it-1', 100, 100, 9);`,
      );

      const report = await reports.spendAnalytics(90, 10, NOW);

      expect(report.total).toBe(540); // 10 (PO) + 30 (expense) + 500 (acquisition)
      expect(report.eventCount).toBe(3);
      expect(report.bySource).toEqual([
        { source: 'PURCHASE_ORDER', total: 10, share: 10 / 540 },
        { source: 'PROJECT_EXPENSE', total: 30, share: 30 / 540 },
        { source: 'ACQUISITION', total: 500, share: 500 / 540 },
      ]);
      // Suppliers: only the PO carries one; the expense + acquisition collapse to "No supplier".
      expect(report.bySupplier.map((g) => [g.name, g.total])).toEqual([
        ['No supplier', 530],
        ['RS', 10],
      ]);
      // Categories: the PO line + the acquisition share Resistors (£510); the expense is uncategorised.
      expect(report.byCategory.map((g) => [g.name, g.total])).toEqual([
        ['Resistors', 510],
        ['Uncategorised', 30],
      ]);
    });

    it('ignores unreceived PO lines and zero-amount events, and yields an empty report when nothing is in window', async () => {
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_name, status, ordered_at) VALUES ('po-2', 'RS', 'ORDERED', ?);",
        [day(-2)],
      );
      // received_qty 0 → no spend yet.
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-2', 'po-2', 5, 0, 2);`,
      );
      const report = await reports.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(0);
      expect(report.eventCount).toBe(0);
      expect(report.bySupplier).toEqual([]);
      expect(report.bySource.every((s) => s.total === 0)).toBe(true);
    });
  });
});
