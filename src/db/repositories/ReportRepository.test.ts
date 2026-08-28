import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toStoredMoney } from '@/lib/money';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MS_PER_DAY, UNASSIGNED_LOCATION_ID } from './constants';
import { DEPRECIATION_MS_PER_MONTH, currentValue } from '@/features/inventory/asset-lifecycle';
import { CategoryRepository } from './CategoryRepository';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ReportRepository } from './ReportRepository';
import { SupplierPartRepository } from './SupplierPartRepository';
import { SupplierRepository } from './SupplierRepository';
import {
  buildInsuranceSchedule,
  type ScheduleItemInput,
  type ScheduleLocationInput,
} from '@/features/reports/insurance-schedule';

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
  let suppliers: SupplierRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    locations = new LocationRepository(driver);
    reports = new ReportRepository(driver);
    supplierParts = new SupplierPartRepository(driver);
    suppliers = new SupplierRepository(driver);
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

    it('applies the same value precedence in SQL as the pure seam does (issue #170)', async () => {
      // The totals are summed by the database, so the precedence rule is stated in SQL as well
      // as in `effectiveUnitValue`/`effectiveUnitCost`. Pin every branch of it here so the two
      // statements cannot drift: manual value wins, else manual cost, else the preferred
      // supplier cost, else unpriced — and a deliberate zero is a value, not a price.
      const shelf = await locations.create({ name: 'Shelf A' });
      const supplierPriced = await items.create({
        name: 'Fallback',
        locationId: shelf.id,
        quantity: 2,
        unitCost: null,
      });
      await supplierParts.create(supplierPriced.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 3,
        isPreferred: true,
      });
      // A manual current value outranks both the manual cost and the supplier's price.
      const revalued = await items.create({
        name: 'Revalued',
        locationId: shelf.id,
        quantity: 2,
        unitCost: 10,
        currentValue: 25,
      });
      await supplierParts.create(revalued.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 99,
        isPreferred: true,
      });
      // A current value of 0 is "worth nothing" — it wins over the cost and reads as unpriced.
      await items.create({
        name: 'Worthless',
        locationId: shelf.id,
        quantity: 4,
        unitCost: 8,
        currentValue: 0,
      });
      await items.create({ name: 'Unpriced', locationId: shelf.id, quantity: 1, unitCost: null });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(56); // 2×3 + 2×25 + 4×0 + 1×0
      expect(report.totalQuantity).toBe(9);
      expect(report.unpricedItemCount).toBe(2); // the zero-valued item and the unpriced one
      // The breakdown beside the headline is the same arithmetic, not a second opinion.
      expect(report.byLocation.find((g) => g.id === shelf.id)).toMatchObject({
        value: 56,
        quantity: 9,
      });
    });

    it('values an item with no manual cost at its preferred supplier cost (Phase-60 precedence)', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      // No manual unitCost: valuation must fall back to the preferred supplier part's cost.
      const item = await items.create({ name: 'Relay', locationId: shelf.id, quantity: 10, unitCost: null });
      await supplierParts.create(item.id, { supplier: { supplierName: 'Cheap Co' }, unitCost: 5 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 7,
        isPreferred: true,
      });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(70); // 10 × £7 (the *preferred* part, not the cheaper one)
      expect(report.unpricedItemCount).toBe(0);
      const shelfGroup = report.byLocation.find((g) => g.id === shelf.id);
      expect(shelfGroup).toMatchObject({ value: 70 });
    });

    it('refuses a preferred supplier cost quoted in another currency (issue #284)', async () => {
      // Gubbins holds no exchange rates, so ¥9,800 cannot become a £ figure. Adding it as
      // "9800" would overstate this line by ~£9,750 — the report must leave it out instead.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const shelf = await locations.create({ name: 'Shelf A' });
      const item = await items.create({
        name: 'Oscilloscope',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
      });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });

      const report = await gbp.inventoryValue();
      expect(report.totalValue).toBe(0);
      expect(report.unpricedItemCount).toBe(1);
      expect(report.byLocation.find((g) => g.id === shelf.id)).toMatchObject({ value: 0 });
      // …and the exclusion is reported rather than left as a silent hole in the total.
      expect(await gbp.foreignCurrencyCostCount()).toBe(1);
    });

    it('still uses a preferred supplier cost in — or implicitly in — the base currency', async () => {
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      // An explicit match, a blank currency and a lower-case/padded code all mean "base".
      const explicit = await items.create({ name: 'Explicit', quantity: 1, unitCost: null });
      await supplierParts.create(explicit.id, {
        supplier: { supplierName: 'Home Co' },
        unitCost: 10,
        currency: 'GBP',
        isPreferred: true,
      });
      const implicit = await items.create({ name: 'Implicit', quantity: 1, unitCost: null });
      await supplierParts.create(implicit.id, {
        supplier: { supplierName: 'Blank Co' },
        unitCost: 20,
        isPreferred: true,
      });
      const scruffy = await items.create({ name: 'Scruffy', quantity: 1, unitCost: null });
      await supplierParts.create(scruffy.id, {
        supplier: { supplierName: 'Lowercase Co' },
        unitCost: 30,
        currency: ' gbp ',
        isPreferred: true,
      });

      const report = await gbp.inventoryValue();
      expect(report.totalValue).toBe(60);
      expect(report.unpricedItemCount).toBe(0);
      expect(await gbp.foreignCurrencyCostCount()).toBe(0);
    });

    it('keeps valuing a foreign-priced item that carries its own manual cost', async () => {
      // A manual cost is the user stating the item's worth in *their* currency, so it wins
      // outright and the supplier's foreign quote is irrelevant — nothing to report.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const item = await items.create({ name: 'Scope', quantity: 1, unitCost: 55 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });

      expect((await gbp.inventoryValue()).totalValue).toBe(55);
      expect(await gbp.foreignCurrencyCostCount()).toBe(0);
    });

    it('does not report an item whose manual current value already covers it', async () => {
      // A manual current value wins over cost entirely, so this item IS in the totals — counting
      // it would warn about a total that is actually complete.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const item = await items.create({ name: 'Scope', quantity: 1, unitCost: null, currentValue: 500 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });

      expect((await gbp.inventoryValue()).totalValue).toBe(500);
      expect((await gbp.insuranceScheduleSummary()).grandTotal).toBe(500);
      expect(await gbp.foreignCurrencyCostCount()).toBe(0);
    });

    it('values as before when the base currency is unknown, and reports no exclusions', async () => {
      // `resolveBaseCurrency` is omitted here (as it is in every other fixture): with no base
      // to compare against, "foreign" is undefinable, so the filter must not engage at all.
      const item = await items.create({ name: 'Scope', quantity: 1, unitCost: null });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });

      expect((await reports.inventoryValue()).totalValue).toBe(9800);
      expect(await reports.foreignCurrencyCostCount()).toBe(0);
    });

    it('excludes a foreign-priced item from the insurance schedule total (issue #284)', async () => {
      // The schedule is the sharpest edge of this bug: a document handed to an insurer.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const shelf = await locations.create({ name: 'Study' });
      const foreign = await items.create({
        name: 'Scope',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
      });
      await supplierParts.create(foreign.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });
      const domestic = await items.create({ name: 'Desk', locationId: shelf.id, quantity: 1, unitCost: 150 });
      expect(domestic.id).toBeTruthy();

      const schedule = await gbp.insuranceScheduleSummary();
      expect(schedule.grandTotal).toBe(150);
    });

    it('lets a manual unitCost win over the preferred supplier cost', async () => {
      const item = await items.create({ name: 'Switch', quantity: 4, unitCost: 2 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 99,
        isPreferred: true,
      });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(8); // 4 × £2 manual, not £99
    });

    it('values dead stock at the preferred supplier cost when unpriced manually', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'OldFan', quantity: 3, unitCost: null });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 6,
        isPreferred: true,
      });
      // Dead-stock reporting is opt-in (issue #92), so the item has to ask to be watched.
      await driver.execute("UPDATE items SET created_at = ?, dead_stock_mode = 'always' WHERE id = ?;", [
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

    it('drops a stocked item from the location breakdown once it is made a variant parent (issue #155)', async () => {
      // "a variant parent holds no stock of its own" is a convention, not an invariant:
      // `setParent` attaches an existing, already-stocked item to a parent without zeroing its
      // stock — so an ordinary item that later becomes a parent keeps its `item_stock` rows.
      const shelf = await locations.create({ name: 'Shed' });
      const bolts = await items.create({
        name: 'M3 bolts',
        locationId: shelf.id,
        quantity: 500,
        unitCost: 0.1,
      });
      const child = await items.create({ name: 'M3 bolts, black', quantity: 0 });
      // Attaching the child turns `bolts` into an abstract parent while it still holds 500 in Shed.
      await items.setParent(child.id, bolts.id);

      const report = await reports.inventoryValue();
      // The headline excludes the now-parent's stock (item-based filter), so the location
      // breakdown must too — otherwise the two disagree and the breakdown over-counts.
      expect(report.totalValue).toBe(0);
      expect(report.byLocation.find((g) => g.id === shelf.id)?.value ?? 0).toBe(0);
      // And `locationStats` reads the same ledger, so Shed values to nothing there as well.
      const stats = await reports.locationStats(shelf.id);
      expect(stats.totalValue).toBe(0);
      expect(stats.totalQuantity).toBe(0);
    });
  });

  // Issue #683 — a CONSUMABLE_GAUGE item is valued along a different axis: its `quantity` is
  // pinned at 0 and it never takes an `item_stock` row, so `quantity × unit cost` reported a
  // full argon cylinder as a confident £0 — in the headline, both breakdowns, the trend, the
  // aging and dead-stock reports, and on the printed insurance schedule.
  describe('gauge valuation (issue #683)', () => {
    /** A gauge holding `net` of `capacity`, priced at `costPerUnitOfMeasure` per unit. */
    async function makeGauge(opts: {
      name: string;
      locationId?: string;
      categoryId?: string;
      capacity?: number;
      net: number;
      costPerUnitOfMeasure?: number | null;
      unitCost?: number | null;
    }) {
      return items.create({
        name: opts.name,
        locationId: opts.locationId,
        categoryId: opts.categoryId,
        trackingMode: 'CONSUMABLE_GAUGE',
        unitCost: opts.unitCost ?? null,
        gauge: {
          unitOfMeasure: 'g',
          grossCapacity: opts.capacity ?? 1000,
          tareWeight: 0,
          currentNetValue: opts.net,
          ...(opts.costPerUnitOfMeasure !== undefined
            ? { costPerUnitOfMeasure: opts.costPerUnitOfMeasure }
            : {}),
        },
      });
    }

    it('values a gauge from its contents, and agrees across headline, category and location', async () => {
      const filament = await categories.create({ name: 'Filament' });
      const shelf = await locations.create({ name: 'Shelf A' });
      // 400 g left at £0.025/g = £10.
      await makeGauge({
        name: 'PLA spool',
        locationId: shelf.id,
        categoryId: filament.id,
        net: 400,
        costPerUnitOfMeasure: 0.025,
      });
      // An ordinary counted item alongside it, so the totals mix both axes.
      await items.create({ name: 'Nozzle', locationId: shelf.id, quantity: 3, unitCost: 5 });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(25); // £10 of filament + 3 × £5
      // The gauge contributes no *units*: 400 grams is not a count, and adding it to the
      // nozzles would make the figure a number of nothing.
      expect(report.totalQuantity).toBe(3);
      expect(report.unpricedItemCount).toBe(0);

      expect(report.byCategory.find((g) => g.name === 'Filament')?.value).toBe(10);
      // The location breakdown reads the `item_stock` ledger, which a gauge never appears in —
      // so it needs its own arm, or the two totals silently stop agreeing (the #155 invariant).
      expect(report.byLocation.find((g) => g.id === shelf.id)?.value).toBe(25);
      expect(report.byLocation.reduce((sum, g) => sum + g.value, 0)).toBe(report.totalValue);

      // `locationStats` values the same stock, so its total must equal that breakdown row.
      const stats = await reports.locationStats(shelf.id);
      expect(stats.totalValue).toBe(25);
      expect(stats.distinctItemCount).toBe(2);
      expect(stats.unpricedItemCount).toBe(0);
      expect(stats.byCategory.find((g) => g.name === 'Filament')?.value).toBe(10);
    });

    it('never prices a gauge from unit cost — an unpriced gauge is reported, not zeroed', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      // A per-*unit* cost of £25 (what the whole spool cost) must not be read per gram: doing
      // so would schedule 400 g as £10,000. It is not a usable price here, so the gauge is
      // unpriced — and says so rather than quietly contributing nothing.
      await makeGauge({ name: 'Priced by the spool', locationId: shelf.id, net: 400, unitCost: 25 });

      const report = await reports.inventoryValue();
      expect(report.totalValue).toBe(0);
      expect(report.unpricedItemCount).toBe(1);
      expect(await reports.unpricedGaugeCount()).toBe(1);
    });

    it('counts only gauges whose contents are actually missing from a total', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      await makeGauge({ name: 'Priced', locationId: shelf.id, net: 400, costPerUnitOfMeasure: 0.01 });
      // Empty: nothing is missing from a total that correctly contains nothing.
      await makeGauge({ name: 'Empty', locationId: shelf.id, net: 0 });
      // Soft-deleted stock is outside every valuation read, so it cannot be "excluded" from one.
      const gone = await makeGauge({ name: 'Gone', locationId: shelf.id, net: 500 });
      await items.softDelete(gone.id);
      const unpriced = await makeGauge({ name: 'Unpriced', locationId: shelf.id, net: 250 });

      expect(await reports.unpricedGaugeCount()).toBe(1);

      // A gauge is never valued from a supplier price, so no currency of one can exclude it —
      // it must not also be counted by the foreign-currency notice, whose only remedy ("give
      // the item its own unit cost") does nothing for a gauge. Needs a base currency to be
      // resolvable *and* a foreign preferred part, or the count returns 0 for unrelated reasons
      // and could not tell the exclusion apart from its absence.
      await supplierParts.create(unpriced.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      expect(await gbp.foreignCurrencyCostCount()).toBe(0);
      // The same part on a *counted* item is excluded, proving the read is live either way.
      const scope = await items.create({ name: 'Oscilloscope', locationId: shelf.id, quantity: 1 });
      await supplierParts.create(scope.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });
      expect(await gbp.foreignCurrencyCostCount()).toBe(1);
    });

    it('schedules a gauge at its contents, and captions the line with the measure', async () => {
      const garage = await locations.create({ name: 'Garage' });
      await makeGauge({
        name: 'Argon cylinder',
        locationId: garage.id,
        capacity: 10,
        net: 6,
        costPerUnitOfMeasure: 6,
      });

      const summary = await reports.insuranceScheduleSummary();
      expect(summary.grandTotal).toBe(36); // 6 × £6 — not the £0 a unit count would give
      expect(summary.groups.find((g) => g.locationId === garage.id)?.subtotal).toBe(36);

      const page = await reports.insuranceScheduleGroupPage(garage.id, { limit: 10 });
      const line = page.rows.find((l) => l.name === 'Argon cylinder')!;
      expect(line.replacementValue).toBe(36);
      // "Qty 0" beside a £36 line reads as a mistake; the document says what it holds.
      expect(line.measure).toEqual({ amount: 6, unit: 'g' });
    });

    it('ages an idle gauge and reports it as dead stock, by its contents', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const gauge = await makeGauge({
        name: 'Resin',
        locationId: shelf.id,
        net: 500,
        costPerUnitOfMeasure: 0.04,
      });
      // Backdate creation past the idle threshold; the gauge has never moved. Dead-stock
      // reporting is opt-in (issue #92), so the item has to ask to be watched.
      await driver.execute("UPDATE items SET created_at = ?, dead_stock_mode = 'always' WHERE id = ?;", [
        Date.now() - 400 * MS_PER_DAY,
        gauge.id,
      ]);

      const dead = await reports.deadStock(90);
      const line = dead.lines.find((l) => l.name === 'Resin')!;
      expect(line.value).toBe(20); // 500 × £0.04
      expect(line.measure).toEqual({ amount: 500, unit: 'g' });
      expect(dead.totalValue).toBe(20);

      // Stock aging values the same contents, but a gauge adds no units to a bucket's quantity.
      const aging = await reports.stockAging();
      expect(aging.totalValue).toBe(20);
      expect(aging.totalQuantity).toBe(0);
    });
  });

  // Issue #458 — aggregate statistics for a single location's contents. The figures read the same
  // per-location `item_stock` ledger and value it by the same seam as `inventoryValue`'s location
  // breakdown, so a location's total here must equal its row there.
  describe('locationStats (issue #458)', () => {
    it('totals value, counts distinct items and units, and groups by category for one location', async () => {
      const caps = await categories.create({ name: 'Capacitors' });
      const shelf = await locations.create({ name: 'Shelf A' });
      const other = await locations.create({ name: 'Shelf B' });

      await items.create({
        name: 'Cap',
        categoryId: caps.id,
        locationId: shelf.id,
        quantity: 10,
        unitCost: 2,
      });
      await items.create({ name: 'Resistor', locationId: shelf.id, quantity: 100, unitCost: 1 });
      await items.create({ name: 'Unpriced', locationId: shelf.id, quantity: 5, unitCost: null });
      // Stock in a different location must not bleed into this location's figures.
      await items.create({ name: 'Elsewhere', locationId: other.id, quantity: 3, unitCost: 50 });

      const stats = await reports.locationStats(shelf.id);
      expect(stats.includesSubtree).toBe(false);
      expect(stats.locationCount).toBe(1);
      expect(stats.totalValue).toBe(120); // 10*2 + 100*1; the unpriced item adds nothing
      expect(stats.totalQuantity).toBe(115);
      expect(stats.distinctItemCount).toBe(3);
      expect(stats.unpricedItemCount).toBe(1);
      // None of these items carry dimensions, so nothing counts towards used volume.
      expect(stats.usedVolume).toBe(0);
      expect(stats.measuredItemCount).toBe(0);
      // Value descending, with the ungrouped bucket forced last regardless of its size.
      expect(stats.byCategory.map((g) => [g.name, g.value])).toEqual([
        ['Capacitors', 20],
        ['Ungrouped', 100],
      ]);

      // A location's total here equals its row on the valuation report's location breakdown.
      const fromReport = (await reports.inventoryValue()).byLocation.find((g) => g.id === shelf.id);
      expect(fromReport).toMatchObject({ value: stats.totalValue, quantity: stats.totalQuantity });
    });

    it('rolls the whole subtree up when asked, and dedupes an item split across it', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });

      // A discrete item first placed in the garage, then split so half of it sits on the shelf.
      const bolts = await items.create({ name: 'Bolts', locationId: garage.id, quantity: 20, unitCost: 1 });
      await items.transferStock(bolts.id, garage.id, shelf.id, 8);
      // A second item living only on the shelf.
      await items.create({ name: 'Nuts', locationId: shelf.id, quantity: 4, unitCost: 5 });

      // The garage alone: only the 12 bolts still there.
      const garageOnly = await reports.locationStats(garage.id);
      expect(garageOnly.includesSubtree).toBe(false);
      expect(garageOnly.distinctItemCount).toBe(1);
      expect(garageOnly.totalQuantity).toBe(12);
      expect(garageOnly.totalValue).toBe(12);

      // The whole subtree: both items, and the split "Bolts" counts once at its full quantity.
      const subtree = await reports.locationStats(garage.id, { includeSubtree: true });
      expect(subtree.includesSubtree).toBe(true);
      expect(subtree.locationCount).toBe(2);
      expect(subtree.distinctItemCount).toBe(2); // Bolts (across both) + Nuts, not three placements
      expect(subtree.totalQuantity).toBe(24); // 20 bolts + 4 nuts
      expect(subtree.totalValue).toBe(40); // 20*1 + 4*5
    });

    it('sums used volume from item dimensions, counting only measured items, over the scope', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });

      // Three 100 mm cubes in the garage — 100×100×100 = 1,000,000 mm³ each.
      await items.create({
        name: 'Boxed',
        locationId: garage.id,
        quantity: 3,
        unitCost: 2,
        width: 100,
        height: 100,
        depth: 100,
      });
      // An unmeasured item in the garage — counts towards items/units but not volume.
      await items.create({ name: 'Loose', locationId: garage.id, quantity: 5, unitCost: 1 });
      // A measured item on the shelf beneath — 200×100×50 = 1,000,000 mm³, two of them.
      await items.create({
        name: 'Shelved',
        locationId: shelf.id,
        quantity: 2,
        unitCost: 3,
        width: 200,
        height: 100,
        depth: 50,
      });

      const garageOnly = await reports.locationStats(garage.id);
      expect(garageOnly.usedVolume).toBe(3_000_000); // 3 × 100³; the unmeasured item adds nothing
      expect(garageOnly.measuredItemCount).toBe(1);
      expect(garageOnly.distinctItemCount).toBe(2);

      const subtree = await reports.locationStats(garage.id, { includeSubtree: true });
      expect(subtree.usedVolume).toBe(5_000_000); // + 2 × 1,000,000 from the shelf beneath
      expect(subtree.measuredItemCount).toBe(2);
    });

    it('is empty for a location holding no stock', async () => {
      const empty = await locations.create({ name: 'Empty' });
      const stats = await reports.locationStats(empty.id);
      expect(stats.distinctItemCount).toBe(0);
      expect(stats.totalValue).toBe(0);
      expect(stats.totalQuantity).toBe(0);
      expect(stats.usedVolume).toBe(0);
      expect(stats.measuredItemCount).toBe(0);
      expect(stats.byCategory).toEqual([]);
    });
  });

  // Issue #411 — the schedule summary is summed by the database, so the delicate money-rounding
  // rule (`roundMoney`) is now stated in SQL as well as in the pure seam. These tests pin the two
  // against each other: the classic tie values SQLite's own `ROUND()` gets wrong, and a randomised
  // fixture differenced against the pure `buildInsuranceSchedule` oracle at each supported minor
  // unit (0dp / 2dp / 3dp). A drift between the SQL and the seam fails the build, not review.
  describe('insuranceScheduleSummary (summed in SQL)', () => {
    /** A deterministic PRNG so a randomised fixture is reproducible rather than flaky. */
    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Read the full location set the way `insuranceScheduleSummary` does, for the pure oracle. */
    async function allLocations(): Promise<ScheduleLocationInput[]> {
      const rows = await driver.query<{ id: string; name: string; parent_id: string | null }>(
        'SELECT id, name, parent_id FROM locations;',
      );
      return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
    }

    it('reproduces roundMoney half-away-from-zero on the ties SQLite ROUND() gets wrong', async () => {
      // 1.005 / 2.675 / 8.165 are the classic cases where `value × 100` lands just below the tie:
      // `roundMoney` corrects the scaled value at 15 significant digits and rounds each *up*, where
      // SQLite's binary-double `ROUND()` would round one or more down and lose a penny. The SQL must
      // match the seam, so the subtotal is 1.01 + 2.68 + 8.17 = 11.86, never 11.84/11.85.
      const study = await locations.create({ name: 'Study' });
      await items.create({ name: 'A', locationId: study.id, quantity: 1, unitCost: 1.005 });
      await items.create({ name: 'B', locationId: study.id, quantity: 1, unitCost: 2.675 });
      await items.create({ name: 'C', locationId: study.id, quantity: 1, unitCost: 8.165 });

      const summary = await reports.insuranceScheduleSummary();
      expect(summary.grandTotal).toBe(11.86);
      expect(summary.groups.find((g) => g.locationId === study.id)?.subtotal).toBe(11.86);
    });

    // Base currency → minor unit: JPY has none (0dp), GBP two (2dp), the Bahraini dinar three (3dp).
    // The rounding must be parameterised by the currency's decimals, so difference each precision.
    it.each([
      ['JPY', 0],
      ['GBP', 2],
      ['BHD', 3],
    ] as const)(
      'matches the pure schedule builder over a randomised %s (%i dp) fixture',
      async (currency, decimals) => {
        const repo = new ReportRepository(driver, { resolveBaseCurrency: () => currency });
        const now = Date.UTC(2026, 6, 19);

        // A small tree so grouping, nesting and ordering are all exercised, not just a flat list.
        const garage = await locations.create({ name: 'Garage' });
        const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });
        const study = await locations.create({ name: 'Study' });
        const roomIds = [garage.id, shelf.id, study.id];

        const rand = mulberry32(4110 + decimals);
        const specs: ScheduleItemInput[] = [];
        const baseSpec = {
          serialNo: null,
          condition: null,
          acquiredAt: null,
          warrantyExpiresAt: null,
          purchasePrice: null,
          preferredSupplierCost: null,
        } as const;

        for (let i = 0; i < 80; i++) {
          const locationId = roomIds[Math.floor(rand() * roomIds.length)]!;
          const quantity = Math.floor(rand() * 9) + 1;
          // Four fractional digits so there is always something to round at 0dp/2dp/3dp, and ties
          // (a trailing 5) are hit often across the run rather than by luck.
          const priced = Math.round(rand() * 5_000_000) / 10_000; // up to 500.0000
          const useCurrentValue = rand() < 0.25;
          const currentValue = useCurrentValue ? Math.round(rand() * 9_000_000) / 10_000 : null;
          const unitCost = useCurrentValue ? null : priced;
          const created = await items.create({
            name: `Asset ${i}`,
            locationId,
            quantity,
            unitCost,
            ...(currentValue === null ? {} : { currentValue }),
          });
          specs.push({
            ...baseSpec,
            id: created.id,
            name: created.name,
            locationId,
            quantity,
            unitCost,
            currentValuePerUnit: currentValue,
          });
        }

        // A couple priced *only* by a preferred supplier part in the base currency, so the
        // correlated supplier-cost subquery is exercised inside the aggregate — issue #411 keeps
        // that lookup per-row rather than moving it to a join. A blank currency reads as "base".
        for (let i = 0; i < 3; i++) {
          const quantity = Math.floor(rand() * 9) + 1;
          const supplierCost = Math.round(rand() * 2_000_000) / 10_000;
          const created = await items.create({
            name: `Supplied ${i}`,
            locationId: study.id,
            quantity,
            unitCost: null,
          });
          await supplierParts.create(created.id, {
            supplier: { supplierName: 'Preferred Co' },
            unitCost: supplierCost,
            isPreferred: true,
          });
          specs.push({
            ...baseSpec,
            id: created.id,
            name: created.name,
            locationId: study.id,
            quantity,
            unitCost: null,
            currentValuePerUnit: null,
            preferredSupplierCost: supplierCost,
          });
        }

        const expected = buildInsuranceSchedule(specs, await allLocations(), now, decimals);
        const actual = await repo.insuranceScheduleSummary(now);

        expect(actual.grandTotal).toBe(expected.grandTotal);
        expect(actual.itemCount).toBe(expected.itemCount);
        // Same ordered groups, each with the same asset count and subtotal to the currency's unit.
        // The full-document builder exposes a group's size as its line count; the summary counts it
        // directly — the two must agree.
        expect(actual.groups.map((g) => [g.locationId, g.itemCount, g.subtotal])).toEqual(
          expected.groups.map((g) => [g.locationId, g.lines.length, g.subtotal]),
        );
      },
    );
  });

  // Issue #688 — straight-line depreciation used to feed nothing. `currentValue()` was shown in
  // the item editor and nowhere else, so an asset priced *only* by what it cost and how long it
  // lasts was valued at 0 by every report and by the printed insurance schedule — while the wiki,
  // the item editor and the bridge schema all said that book value was the figure they used.
  describe('depreciated purchase price as the last valuation fallback (issue #688)', () => {
    /** An acquisition day, and a `now` exactly `months` depreciation-months after it. */
    function acquiredAndNow(months: number): { acquiredAt: string; now: number } {
      const acquiredAt = '2025-01-01';
      return { acquiredAt, now: Date.parse(acquiredAt) + months * DEPRECIATION_MS_PER_MONTH };
    }

    it('values an asset nothing else prices at its book value, and does not call it unpriced', async () => {
      // Half of a 24-month term elapsed → half of £1,200 written off, £600 a unit, £1,200 for two.
      const { acquiredAt, now } = acquiredAndNow(12);
      await items.create({
        name: 'Bandsaw',
        quantity: 2,
        unitCost: null,
        purchasePrice: 1200,
        depreciationMonths: 24,
        acquiredAt,
      });

      const report = await reports.inventoryValue(now);
      expect(report.totalValue).toBe(1200);
      expect(report.unpricedItemCount).toBe(0);
    });

    it('stays below a unit cost and a preferred supplier price', async () => {
      const { acquiredAt, now } = acquiredAndNow(12);
      const asset = { purchasePrice: 1200, depreciationMonths: 24, acquiredAt } as const;

      await items.create({ name: 'Priced', quantity: 1, unitCost: 5, ...asset });
      const supplied = await items.create({ name: 'Supplied', quantity: 1, unitCost: null, ...asset });
      await supplierParts.create(supplied.id, {
        supplier: { supplierName: 'Preferred Co' },
        unitCost: 7,
        isPreferred: true,
      });

      // 5 + 7, not 600 + 600: the book value is what a report reaches for last, never first.
      expect((await reports.inventoryValue(now)).totalValue).toBe(12);
    });

    it('stays below a manual current value, which is what the item editor promises', async () => {
      const { acquiredAt, now } = acquiredAndNow(12);
      await items.create({
        name: 'Collectible',
        quantity: 1,
        unitCost: null,
        currentValue: 2500,
        purchasePrice: 1200,
        depreciationMonths: 24,
        acquiredAt,
      });

      expect((await reports.inventoryValue(now)).totalValue).toBe(2500);
    });

    it('keeps the purchase price flat with no depreciation term, and with no acquisition date', async () => {
      const { acquiredAt, now } = acquiredAndNow(36);
      await items.create({
        name: 'Flat',
        quantity: 1,
        unitCost: null,
        purchasePrice: 400,
        depreciationMonths: null,
        acquiredAt,
      });
      // No acquisition date ⇒ treated as just acquired, so nothing has been written off yet.
      await items.create({
        name: 'Undated',
        quantity: 1,
        unitCost: null,
        purchasePrice: 100,
        depreciationMonths: 12,
        acquiredAt: null,
      });

      expect((await reports.inventoryValue(now)).totalValue).toBe(500);
    });

    it('floors a fully-expired term at zero rather than going negative', async () => {
      // Three times a 12-month term has elapsed: the straight line would read −£2,400 unclamped.
      const { acquiredAt, now } = acquiredAndNow(36);
      await items.create({
        name: 'Written off',
        quantity: 1,
        unitCost: null,
        purchasePrice: 1200,
        depreciationMonths: 12,
        acquiredAt,
      });

      const report = await reports.inventoryValue(now);
      expect(report.totalValue).toBe(0);
      // Worth nothing is a real answer, but the totals still report it as an item with no
      // usable price — `unit_value > 0` is what that count has always meant.
      expect(report.unpricedItemCount).toBe(1);
    });

    it('writes nothing off before the acquisition date', async () => {
      // `now` a year *before* the item was acquired: the proportion clamps at 0, not a negative.
      const { acquiredAt, now } = acquiredAndNow(-12);
      await items.create({
        name: 'Future',
        quantity: 1,
        unitCost: null,
        purchasePrice: 900,
        depreciationMonths: 24,
        acquiredAt,
      });

      expect((await reports.inventoryValue(now)).totalValue).toBe(900);
    });

    // The fallback is deliberately a *valuation* rule and stops there. Dead stock reports the
    // capital tied up in stock that is not moving — what it cost to acquire, which writing the
    // asset down over its life refunds none of; turnover's cost of goods and ABC's annual
    // consumption value are the same kind of figure. Letting a residual book value into any of
    // the three would be the same category error as letting one price a purchase-order line.
    it('is not used by the cost figures — dead stock, turnover and ABC (issue #688)', async () => {
      const { acquiredAt, now } = acquiredAndNow(12);
      const asset = { unitCost: null, purchasePrice: 1200, depreciationMonths: 24, acquiredAt } as const;
      // Two assets, because the three reports need opposite ledgers: dead stock wants one that has
      // NOT moved inside the window, turnover and ABC one that has. A single item cannot be both,
      // and a moved one is simply not a dead-stock candidate — which would leave that assertion
      // passing on an empty report however the cost seam behaved.
      const idle = await items.create({ name: 'Idle bandsaw', quantity: 4, ...asset });
      const used = await items.create({ name: 'Used bandsaw', quantity: 4, ...asset });
      await driver.execute(
        "UPDATE items SET created_at = ?, dead_stock_mode = 'always' WHERE id IN (?, ?);",
        [now - 120 * MS_PER_DAY, idle.id, used.id],
      );
      // One unit consumed inside the window, so turnover and ABC have something to value — and so
      // `used` is still live, leaving `idle` as the only dead-stock line.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at) VALUES (?, ?, 'QUANTITY_CHANGE', -1, ?);`,
        [crypto.randomUUID(), used.id, now - 10 * MS_PER_DAY],
      );

      // The idle asset IS reported — the report is not empty — and the capital it ties up reads
      // £0, not the 4 × £600 the valuation reports show for exactly the same stock.
      const dead = await reports.deadStock(30, now);
      expect(dead.lines.map((l) => l.name)).toEqual(['Idle bandsaw']);
      expect(dead.totalValue).toBe(0);

      expect((await reports.turnover(30, now)).totalCogs).toBe(0);
      // Both items are ranked; neither carries any consumption value to rank them by.
      expect((await reports.abcAnalysis(30, now)).lines.map((l) => l.annualValue)).toEqual([0, 0]);

      // The same two items, through the valuation seam, are worth their book value — the two
      // answers differ on purpose, and this pins that they do.
      expect((await reports.inventoryValue(now)).totalValue).toBe(4800);
    });

    it('schedules the asset at its book value in the insurance schedule, summary and page alike', async () => {
      const { acquiredAt, now } = acquiredAndNow(12);
      const study = await locations.create({ name: 'Study' });
      await items.create({
        name: 'Bandsaw',
        locationId: study.id,
        quantity: 2,
        unitCost: null,
        purchasePrice: 1200,
        depreciationMonths: 24,
        acquiredAt,
      });

      const summary = await reports.insuranceScheduleSummary(now);
      expect(summary.grandTotal).toBe(1200);
      expect(summary.groups.find((g) => g.locationId === study.id)?.subtotal).toBe(1200);

      // The page's lines are folded in JavaScript while the totals above are summed in SQL, so
      // the two paths must land on the same figure or the document does not add up.
      const page = await reports.insuranceScheduleGroupPage(study.id, {}, {}, now);
      expect(page.rows.map((l) => l.replacementValue)).toEqual([1200]);
    });

    it('no longer reports the asset as an item with no price to fix', async () => {
      const { acquiredAt, now } = acquiredAndNow(12);
      await items.create({
        name: 'Bandsaw',
        quantity: 1,
        unitCost: null,
        purchasePrice: 1200,
        depreciationMonths: 24,
        acquiredAt,
      });

      const hygiene = await reports.dataHygiene(90, now);
      expect(hygiene.sections.find((s) => s.kind === 'missing-price')!.count).toBe(0);
    });

    it('excludes it from the foreign-currency notice, which counts only items nothing else values', async () => {
      const { acquiredAt } = acquiredAndNow(12);
      const repo = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const asset = await items.create({
        name: 'Imported',
        quantity: 1,
        unitCost: null,
        purchasePrice: 1200,
        depreciationMonths: 24,
        acquiredAt,
      });
      await supplierParts.create(asset.id, {
        supplier: { supplierName: 'Yen Co' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });

      // The yen price is still declined, but the asset is valued by its book value, so warning
      // that it has been left out of the total would be the same false alarm pointed the other way.
      expect(await repo.foreignCurrencyCostCount()).toBe(0);
    });

    it('matches the pure `currentValue` seam over a randomised fixture', async () => {
      // The straight-line formula is now stated twice — once in `asset-lifecycle.ts` for the item
      // editor, once in SQL so a whole-inventory total can be summed by the database. This pins
      // the second against the first. The catalogue's per-line `unitCost` is the unrounded value
      // the cost seam resolved, so it compares the expressions themselves rather than a rounded
      // headline that could hide a drift of a fraction of a penny.
      let seed = 90210;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };

      const expected = new Map<string, number>();
      const now = Date.UTC(2026, 6, 19);
      for (let i = 0; i < 60; i++) {
        // Four fractional digits, a term of 1–60 months, and an acquisition anywhere from six
        // years back to a year ahead — so mid-term, long-expired and not-yet-started all occur.
        const purchasePrice = Math.round(rand() * 5_000_000) / 10_000;
        const depreciationMonths = Math.floor(rand() * 60) + 1;
        const acquiredAt = new Date(now - Math.floor((rand() * 7 - 1) * 365 * MS_PER_DAY))
          .toISOString()
          .slice(0, 10);
        const created = await items.create({
          name: `Asset ${i}`,
          quantity: 1,
          unitCost: null,
          purchasePrice,
          depreciationMonths,
          acquiredAt,
        });
        expected.set(
          created.id,
          currentValue({ acquiredAt, warrantyExpiresAt: null, purchasePrice, depreciationMonths }, now)!,
        );
      }

      const catalogue = await reports.partsCatalogue({ kind: 'all' }, {}, now);
      const lines = catalogue.groups.flatMap((g) => g.lines);
      expect(lines).toHaveLength(expected.size);
      for (const line of lines) {
        // Both sides quantise to whole stored micro-units (1e-6 of a major unit), so five decimal
        // places is a stricter agreement than any figure the app ever displays.
        expect(line.unitCost).toBeCloseTo(expected.get(line.id)!, 5);
      }
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
      expect(report.windowDays).toBe(10);
      expect(report.lines).toEqual([{ unit: null, totalConsumed: 50, perDay: 5 }]);
    });

    it('reports each unit of measure on its own line, never summed (issue #685)', async () => {
      const now = Date.now();
      // Screws counted as bare things, filament weighed in grams, resin measured in millilitres.
      const screws = await items.create({ name: 'Screws', quantity: 100 });
      const filament = await items.create({
        name: 'Filament',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 800 },
      });
      const resin = await items.create({
        name: 'Resin',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'ml', grossCapacity: 500, currentNetValue: 500 },
      });
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
         VALUES (?, ?, 'QUANTITY_CHANGE', -6, ?);`,
        [crypto.randomUUID(), screws.id, now - 5 * MS_PER_DAY],
      );
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, net_value_delta, created_at)
         VALUES (?, ?, 'GAUGE_UPDATE', -400, ?), (?, ?, 'GAUGE_UPDATE', -50, ?);`,
        [
          crypto.randomUUID(),
          filament.id,
          now - 2 * MS_PER_DAY,
          crypto.randomUUID(),
          resin.id,
          now - MS_PER_DAY,
        ],
      );

      const report = await reports.consumptionRate(10, now);
      expect(report.lines).toEqual([
        { unit: 'g', totalConsumed: 400, perDay: 40 },
        { unit: 'ml', totalConsumed: 50, perDay: 5 },
        { unit: null, totalConsumed: 6, perDay: 0.6 },
      ]);
    });

    it('counts a gauge item itself as a bare count, not as more of what it holds', async () => {
      const now = Date.now();
      // A gauge's unit describes its contents, so 2 cylinders leaving is not 2 more litres.
      const cylinder = await items.create({
        name: 'Argon cylinder',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'L', grossCapacity: 10, currentNetValue: 10 },
      });
      // Sold rather than lent: the cylinders have to *leave for good* to be counted at all
      // (issue #571), and this test is about which unit they are counted in.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
         VALUES (?, ?, 'SOLD', -2, ?);`,
        [crypto.randomUUID(), cylinder.id, now - 3 * MS_PER_DAY],
      );
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, net_value_delta, created_at)
         VALUES (?, ?, 'GAUGE_UPDATE', -4, ?);`,
        [crypto.randomUUID(), cylinder.id, now - 2 * MS_PER_DAY],
      );

      const report = await reports.consumptionRate(10, now);
      expect(report.lines).toEqual([
        { unit: 'L', totalConsumed: 4, perDay: 0.4 },
        { unit: null, totalConsumed: 2, perDay: 0.2 },
      ]);
    });

    // A loan is stock off the shelf, not stock used up: the check-out's negative delta is
    // cancelled by the check-in that brings the same units back. Counting the outbound leg made
    // a tool library read as a consumer of its own tools (issue #571).
    it('ignores a loan, a supplier return and a disassembly, counting only stock gone for good', async () => {
      const now = Date.now();
      const drill = await items.create({ name: 'Drill', quantity: 10 });
      const spares = await items.create({ name: 'Spares', quantity: 10 });
      const kit = await items.create({ name: 'Kit', quantity: 10 });
      const rows: readonly (readonly [string, string, number, number])[] = [
        [drill.id, 'CHECKED_OUT', -5, now - 4 * MS_PER_DAY],
        [drill.id, 'CHECKED_IN', 5, now - 3 * MS_PER_DAY],
        [spares.id, 'RETURNED_TO_SUPPLIER', -4, now - 3 * MS_PER_DAY],
        [kit.id, 'DISASSEMBLED', -3, now - 2 * MS_PER_DAY],
        [drill.id, 'SOLD', -2, now - MS_PER_DAY],
      ];
      for (const [itemId, action, delta, at] of rows) {
        await driver.execute(
          `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
           VALUES (?, ?, ?, ?, ?);`,
          [crypto.randomUUID(), itemId, action, delta, at],
        );
      }

      // Only the sale counts: 2 units over 10 days.
      const report = await reports.consumptionRate(10, now);
      expect(report.lines).toEqual([{ unit: null, totalConsumed: 2, perDay: 0.2 }]);
    });

    // `net_value_delta` on a `SOLD` row is the sale *proceeds*, not material - money sharing a
    // column with grams. `sell` only ever writes those positive, so this drives the case directly
    // rather than through the API: the guard being pinned is that only a gauge-bearing action may
    // be read as a material draw, whatever sign a money row happens to carry.
    it('never reads a sale price as material drawn from a gauge', async () => {
      const now = Date.now();
      const filament = await items.create({
        name: 'Filament',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 800 },
      });
      // A money row in the column a gauge measures grams in, forced negative so a sign test
      // alone would admit it. Nothing writes this today; the action list is what keeps it out.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, net_value_delta, created_at)
         VALUES (?, ?, 'SOLD', -25, ?);`,
        [crypto.randomUUID(), filament.id, now - 2 * MS_PER_DAY],
      );
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, net_value_delta, created_at)
         VALUES (?, ?, 'GAUGE_UPDATE', -100, ?);`,
        [crypto.randomUUID(), filament.id, now - MS_PER_DAY],
      );

      const report = await reports.consumptionRate(10, now);
      expect(report.lines).toEqual([{ unit: 'g', totalConsumed: 100, perDay: 10 }]);
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
      // Low-stock is opt-in: pass a positive blanket threshold (the default is off = 0).
      expect(await reports.lowStockCount({ qtyThreshold: 5, gaugePercent: 15 })).toBe(2);
    });

    it('counts nothing under the default (off) blanket until an item opts in', async () => {
      await items.create({ name: 'BareLow', quantity: 1 });
      const watched = await items.create({ name: 'Watched', quantity: 1 });
      expect(await reports.lowStockCount()).toBe(0); // default thresholds = 0 = off

      await items.update(watched.id, { reorderPoint: 3 });
      expect(await reports.lowStockCount()).toBe(1);
    });
  });

  describe('outOfStockCount (A2 nav-tile count)', () => {
    it('counts DISCRETE items at zero and gauges run dry — but not items with stock', async () => {
      await items.create({ name: 'Empty', quantity: 0 }); // out ✓
      await items.create({ name: 'InStock', quantity: 5 }); // has stock ✗
      await items.create({
        name: 'DryResin',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 0 }, // empty ✓
      });
      await items.create({
        name: 'HalfResin',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 500 }, // has stock ✗
      });
      expect(await reports.outOfStockCount()).toBe(2);
    });

    it('never counts unlimited-supply or UNTRACKED items sitting at zero', async () => {
      // An infinite source can never run dry.
      await items.create({ name: 'Tap water', quantity: 0, isUnlimited: true });
      // UNTRACKED items sit at quantity 0 by design (they opt out of stock counting).
      const untracked = await items.create({ name: 'Reference manual', quantity: 0 });
      await items.update(untracked.id, { trackingMode: 'UNTRACKED' });
      expect(await reports.outOfStockCount()).toBe(0);
    });
  });

  describe('deadStock', () => {
    it('lists items with no movement in N days, tying up their value', async () => {
      const now = Date.now();
      const idle = await items.create({ name: 'Idle', quantity: 4, unitCost: 5 });
      const moved = await items.create({ name: 'Moved', quantity: 4, unitCost: 5 });

      // Backdate both items' creation well past the cutoff; neither has movement history
      // yet. Reporting is opt-in (issue #92), so both must be switched on to be considered.
      await driver.execute("UPDATE items SET created_at = ?, dead_stock_mode = 'always' WHERE id = ?;", [
        now - 120 * MS_PER_DAY,
        idle.id,
      ]);
      await driver.execute("UPDATE items SET created_at = ?, dead_stock_mode = 'always' WHERE id = ?;", [
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

    // Dead-stock reporting opt-in (issue #92) --------------------------------------

    /** An item idle for 200 days in `locationId`, so only the opt-in decides the outcome. */
    async function idleItem(name: string, locationId?: string, now = Date.now()) {
      const item = await items.create({
        name,
        quantity: 1,
        unitCost: 1,
        ...(locationId ? { locationId } : {}),
      });
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 200 * MS_PER_DAY,
        item.id,
      ]);
      return item;
    }

    it('reports nothing by default — reporting is opt-in', async () => {
      const now = Date.now();
      await idleItem('Forgotten', undefined, now);

      const report = await reports.deadStock(30, now);
      expect(report.lines).toEqual([]);
      // Nothing was even considered, which is what lets the UI distinguish "nothing is
      // being watched" from "everything watched is still moving".
      expect(report.consideredCount).toBe(0);
    });

    it('reports an item that opts in on its own', async () => {
      const now = Date.now();
      const item = await idleItem('Watched', undefined, now);
      await driver.execute("UPDATE items SET dead_stock_mode = 'always' WHERE id = ?;", [item.id]);

      const report = await reports.deadStock(30, now);
      expect(report.lines.map((l) => l.name)).toEqual(['Watched']);
      expect(report.consideredCount).toBe(1);
    });

    it('reports items in a location that opts in, without touching each item', async () => {
      const now = Date.now();
      const garage = await locations.create({ name: 'Garage' });
      await idleItem('In garage', garage.id, now);
      await idleItem('Elsewhere', undefined, now);
      await driver.execute("UPDATE locations SET dead_stock_mode = 'always' WHERE id = ?;", [garage.id]);

      const report = await reports.deadStock(30, now);
      expect(report.lines.map((l) => l.name)).toEqual(['In garage']);
    });

    it('inherits a location opt-in down through sub-locations', async () => {
      const now = Date.now();
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });
      await idleItem('On shelf', shelf.id, now);
      await driver.execute("UPDATE locations SET dead_stock_mode = 'always' WHERE id = ?;", [garage.id]);

      const report = await reports.deadStock(30, now);
      expect(report.lines.map((l) => l.name)).toEqual(['On shelf']);
    });

    it("lets an item's own 'never' override a location that opts in", async () => {
      const now = Date.now();
      const garage = await locations.create({ name: 'Garage' });
      const item = await idleItem('Exempt', garage.id, now);
      await driver.execute("UPDATE locations SET dead_stock_mode = 'always' WHERE id = ?;", [garage.id]);
      await driver.execute("UPDATE items SET dead_stock_mode = 'never' WHERE id = ?;", [item.id]);

      const report = await reports.deadStock(30, now);
      expect(report.lines).toEqual([]);
    });

    it("honours a location's own idle threshold over the global default", async () => {
      const now = Date.now();
      const storage = await locations.create({ name: 'Deep storage' });
      await idleItem('Archived', storage.id, now); // idle 200 days
      await driver.execute(
        "UPDATE locations SET dead_stock_mode = 'always', dead_stock_days = 365 WHERE id = ?;",
        [storage.id],
      );

      // Idle 200 days: past the global 30-day default, but well inside the location's 365.
      const report = await reports.deadStock(30, now);
      expect(report.lines).toEqual([]);
      // Still counted as watched — it just isn't dead yet.
      expect(report.consideredCount).toBe(1);
    });

    // Clearing an item's Activity Log (issue #620) deletes its movement rows and leaves one
    // marker carrying no deltas, so "last moved" goes unknown. Judging from `created_at` then
    // aged the item by everything the clear erased (issue #686).
    it("judges a cleared log from the clear, not the item's creation", async () => {
      const now = Date.now();
      const item = await idleItem('Cleared', undefined, now); // created 200 days ago
      await driver.execute("UPDATE items SET dead_stock_mode = 'always' WHERE id = ?;", [item.id]);

      await items.clearHistory(item.id, 'Device');

      // Nothing is known before the clear, which just happened — so the item is not idle at all.
      const report = await reports.deadStock(30, now);
      expect(report.lines).toEqual([]);
      expect(report.consideredCount).toBe(1);

      // The ledger is append-only, so the marker's instant is read back rather than dictated.
      const [marker] = await driver.query<{ created_at: number }>(
        'SELECT created_at FROM item_history WHERE item_id = ?;',
        [item.id],
      );
      const clearedAt = marker?.created_at ?? now;

      // Sixty days on with no movement since, it is dead — but idle since the clear (60 days),
      // not since its creation (260 by then).
      const later = await reports.deadStock(30, clearedAt + 60 * MS_PER_DAY);
      expect(later.lines.map((l) => l.name)).toEqual(['Cleared']);
      expect(later.lines[0]?.idleDays).toBe(60);
    });

    it('lets a movement recorded after a clear override the clear', async () => {
      const now = Date.now();
      const item = await idleItem('Restocked', undefined, now);
      await driver.execute("UPDATE items SET dead_stock_mode = 'always' WHERE id = ?;", [item.id]);
      await items.clearHistory(item.id, 'Device');
      const [marker] = await driver.query<{ created_at: number }>(
        'SELECT created_at FROM item_history WHERE item_id = ?;',
        [item.id],
      );
      const clearedAt = marker?.created_at ?? now;

      // Stocked 50 days after the clear — the later of the two is what it is judged on.
      await driver.execute(
        `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at) VALUES (?, ?, 'QUANTITY_CHANGE', 3, ?);`,
        [crypto.randomUUID(), item.id, clearedAt + 50 * MS_PER_DAY],
      );

      // Sixty days after the clear is only ten days after that movement → still live.
      const report = await reports.deadStock(30, clearedAt + 60 * MS_PER_DAY);
      expect(report.lines).toEqual([]);
      expect(report.consideredCount).toBe(1);
    });

    it('reports the threshold each line was judged against', async () => {
      const now = Date.now();
      const bench = await locations.create({ name: 'Workbench' });
      await idleItem('Stale', bench.id, now);
      await driver.execute(
        "UPDATE locations SET dead_stock_mode = 'always', dead_stock_days = 14 WHERE id = ?;",
        [bench.id],
      );

      const report = await reports.deadStock(30, now);
      expect(report.lines[0]).toMatchObject({ name: 'Stale', thresholdDays: 14 });
    });
  });

  describe('deadStockPolicy', () => {
    it('resolves the effective policy for one item, naming the deciding location', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });
      const item = await items.create({ name: 'Widget', locationId: shelf.id });
      await driver.execute("UPDATE locations SET dead_stock_mode = 'always' WHERE id = ?;", [garage.id]);
      await driver.execute('UPDATE locations SET dead_stock_days = 45 WHERE id = ?;', [shelf.id]);

      const policy = await reports.deadStockPolicy(item.id, 90);
      expect(policy).toMatchObject({
        reported: true,
        reportedFrom: { name: 'Garage' },
        thresholdDays: 45,
        thresholdFrom: { name: 'Shelf' },
      });
    });

    it('returns null for an item that does not exist', async () => {
      expect(await reports.deadStockPolicy('nope', 90)).toBeNull();
    });
  });

  // Phase 65 — reorder shortfall + plan ------------------------------------------
  describe('listReorderShortfall (Phase 65)', () => {
    /** Insert a purchase order (default ORDERED) with a single line for `itemId`. */
    async function addPoLine(
      itemId: string,
      orderedQty: number,
      receivedQty = 0,
      status = 'ORDERED',
    ): Promise<void> {
      const poId = crypto.randomUUID();
      const supplier = await suppliers.resolveOrCreate('Acme');
      await driver.execute(
        'INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES (?, ?, ?, ?);',
        [poId, supplier.id, status, Date.now()],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES (?, ?, ?, ?, ?, 1);`,
        [crypto.randomUUID(), poId, itemId, orderedQty, receivedQty],
      );
    }

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
      await supplierParts.create(item.id, { supplier: { supplierName: 'Non-preferred' }, unitCost: 1 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'DigiKey' },
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

    it('carries the preferred quote’s own currency, guard-free (issue #569)', async () => {
      const item = await items.create({ name: 'Imported relay', quantity: 0 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Eurotech' },
        unitCost: 12.5,
        currency: 'EUR',
        isPreferred: true,
      });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      const row = rows.find((r) => r.itemId === item.id)!;
      // A valuation drops a foreign quote because it has to sum it; a reorder plan keeps it,
      // because it is what the part actually costs to buy — the code is what makes it usable.
      expect(row.preferredSupplier!.unitCost).toBe(12.5);
      expect(row.preferredSupplier!.currency).toBe('EUR');
    });

    it('reports no currency for a quote in the base one', async () => {
      const item = await items.create({ name: 'Local bolt', quantity: 0 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Acme' },
        unitCost: 0.4,
        isPreferred: true,
      });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      expect(rows.find((r) => r.itemId === item.id)!.preferredSupplier!.currency).toBeNull();
    });

    it('threads the preferred supplier price-breaks through (issue #37)', async () => {
      const item = await items.create({ name: 'Resistor', quantity: 0, reorderPoint: 250 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'DigiKey' },
        unitCost: 0.1,
        isPreferred: true,
        priceBreaks: [
          { qty: 100, unitCost: 0.08 },
          { qty: 1000, unitCost: 0.05 },
        ],
      });
      const rows = await reports.listReorderShortfall({ qtyThreshold: 5 });
      const row = rows.find((r) => r.itemId === item.id)!;
      expect(row.preferredSupplier!.priceBreaks).toEqual([
        { qty: 100, unitCost: 0.08 },
        { qty: 1000, unitCost: 0.05 },
      ]);
    });

    it('costs the reorder plan line at its order quantity via price-breaks (issue #37)', async () => {
      const item = await items.create({ name: 'Resistor', quantity: 0, reorderPoint: 250 });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'DigiKey' },
        unitCost: 0.1,
        isPreferred: true,
        priceBreaks: [{ qty: 100, unitCost: 0.08 }],
      });
      const plan = await reports.reorderPlan({ qtyThreshold: 5 });
      const line = plan.flatMap((g) => g.lines).find((l) => l.itemId === item.id)!;
      // Order quantity 250 clears the 100+ break → 0.08, not the flat 0.10.
      expect(line.orderQty).toBe(250);
      expect(line.unitCost).toBe(0.08);
    });

    it('returns null preferredSupplier when no supplier part is marked preferred', async () => {
      const item = await items.create({ name: 'NoPreferred', quantity: 0 });
      await supplierParts.create(item.id, { supplier: { supplierName: 'Some Supplier' }, unitCost: 1 });
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

    it('nets stock already on order off the shortfall', async () => {
      const item = await items.create({ name: 'PartlyCovered', quantity: 2 }); // base shortfall 3
      await addPoLine(item.id, 2); // 2 already on an open PO
      const row = (await reports.listReorderShortfall({ qtyThreshold: 5 })).find(
        (r) => r.itemId === item.id,
      )!;
      expect(row.onOrder).toBe(2);
      expect(row.shortfall).toBe(1); // max(0, 3 − 2)
    });

    it('drops the shortfall to zero when incoming stock fully covers it', async () => {
      const item = await items.create({ name: 'FullyCovered', quantity: 2 }); // base shortfall 3
      await addPoLine(item.id, 5);
      const row = (await reports.listReorderShortfall({ qtyThreshold: 5 })).find(
        (r) => r.itemId === item.id,
      )!;
      expect(row.onOrder).toBe(5);
      expect(row.shortfall).toBe(0);
    });

    it('counts only the still-outstanding (unreceived) portion as on order', async () => {
      const item = await items.create({ name: 'PartlyReceived', quantity: 2 }); // base shortfall 3
      await addPoLine(item.id, 5, 4); // ordered 5, received 4 → 1 outstanding
      const row = (await reports.listReorderShortfall({ qtyThreshold: 5 })).find(
        (r) => r.itemId === item.id,
      )!;
      expect(row.onOrder).toBe(1);
      expect(row.shortfall).toBe(2); // max(0, 3 − 1)
    });

    it('ignores DRAFT and CANCELLED purchase orders when netting', async () => {
      const item = await items.create({ name: 'OnlyDraft', quantity: 2 }); // base shortfall 3
      await addPoLine(item.id, 5, 0, 'DRAFT');
      await addPoLine(item.id, 5, 0, 'CANCELLED');
      const row = (await reports.listReorderShortfall({ qtyThreshold: 5 })).find(
        (r) => r.itemId === item.id,
      )!;
      expect(row.onOrder).toBe(0);
      expect(row.shortfall).toBe(3);
    });
  });

  describe('reorderPlan (Phase 65)', () => {
    it('delegates to buildReorderPlan, producing correct supplier groups', async () => {
      const r1 = await items.create({ name: 'R1', quantity: 0 });
      await items.create({ name: 'R2', quantity: 1 });
      await supplierParts.create(r1.id, {
        supplier: { supplierName: 'DigiKey' },
        unitCost: 0.1,
        isPreferred: true,
      });
      // r2 has no preferred supplier → goes to Unassigned.

      const plan = await reports.reorderPlan({ qtyThreshold: 5 });
      const dk = plan.find((g) => g.supplierName === 'DigiKey');
      const ua = plan.find((g) => g.supplierName === 'Unassigned');
      expect(dk).toBeDefined();
      expect(ua).toBeDefined();
      // DigiKey sorts before Unassigned.
      expect(plan[0]!.supplierName).toBe('DigiKey');
    });

    it('omits an item whose shortfall is fully covered by stock on order', async () => {
      const covered = await items.create({ name: 'AlreadyOnOrder', quantity: 0 }); // base shortfall 5
      const stillLow = await items.create({ name: 'StillLow', quantity: 1 });
      const poId = crypto.randomUUID();
      const acme = await suppliers.resolveOrCreate('Acme');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES (?, ?, 'ORDERED', ?);",
        [poId, acme.id, Date.now()],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES (?, ?, ?, 10, 0, 1);`,
        [crypto.randomUUID(), poId, covered.id],
      );

      const plan = await reports.reorderPlan({ qtyThreshold: 5 });
      const lines = plan.flatMap((g) => g.lines);
      expect(lines.some((l) => l.itemId === covered.id)).toBe(false);
      expect(lines.some((l) => l.itemId === stillLow.id)).toBe(true);
    });
  });

  // Phase 74 — advanced analytics -----------------------------------------------
  /** Insert one append-only ledger row under an explicit action. */
  async function addHistoryAs(itemId: string, action: string, delta: number, at: number): Promise<void> {
    await driver.execute(
      `INSERT INTO item_history (id, item_id, action, quantity_delta, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [crypto.randomUUID(), itemId, action, delta, at],
    );
  }

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

    // ABC's whole job is to say what deserves tighter stock control. Ranking a weekly-lent tool
    // as class A said "buy more of this" about something that comes back every time (issue #571).
    it('does not rank a repeatedly-lent tool as consumed', async () => {
      const now = Date.now();
      const lent = await items.create({ name: 'Lent drill', quantity: 10, unitCost: 50 });
      const used = await items.create({ name: 'Used screws', quantity: 100, unitCost: 1 });
      // Five loans out and back over the year - no net movement, and no consumption either.
      for (let week = 1; week <= 5; week += 1) {
        await addHistoryAs(lent.id, 'CHECKED_OUT', -2, now - week * 14 * MS_PER_DAY);
        await addHistoryAs(lent.id, 'CHECKED_IN', 2, now - (week * 14 - 1) * MS_PER_DAY);
      }
      await addHistoryAs(used.id, 'SOLD', -20, now - 30 * MS_PER_DAY);

      const report = await reports.abcAnalysis(365, now);
      const lentLine = report.lines.find((l) => l.id === lent.id)!;
      const usedLine = report.lines.find((l) => l.id === used.id)!;
      expect(lentLine.annualValue).toBe(0);
      expect(lentLine.tier).toBe('C');
      expect(usedLine.annualValue).toBe(20); // 20 x GBP 1
      expect(usedLine.tier).toBe('A');
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

    // A loan contributes no cost of goods, but it *is* real movement, so it must still be
    // reversed when reconstructing what was on hand at the window start (issue #571).
    it('books no cost of goods for a loan, while still reconstructing the holding from it', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Lent jig', quantity: 6, unitCost: 5 });
      // Out and back inside the window: net zero movement, so the holding never changed.
      await addHistoryAs(item.id, 'CHECKED_OUT', -4, now - 10 * MS_PER_DAY);
      await addHistoryAs(item.id, 'CHECKED_IN', 4, now - 5 * MS_PER_DAY);

      const report = await reports.turnover(30, now);
      const line = report.lines.find((l) => l.id === item.id)!;
      expect(line.cogs).toBe(0);
      // startQty = 6 - 0 = 6; avgQty = 6; avgValue = 30 - the stock is still all there.
      expect(line.avgValue).toBe(30);
      expect(line.turnover).toBe(0);
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

    // Clearing an item's Activity Log (issue #620) deletes the inbound rows this ages from, so
    // without the clear instant the item would be aged from the day its row was created — which
    // dates the row, not the stock (the sibling of issue #686).
    it("ages a cleared log from the clear rather than the item's creation", async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Restocked', quantity: 5, unitCost: 1 });
      await driver.execute('UPDATE items SET created_at = ? WHERE id = ?;', [
        now - 200 * MS_PER_DAY,
        item.id,
      ]);
      await addHistory(item.id, 5, now - 150 * MS_PER_DAY);

      await items.clearHistory(item.id, 'Device');

      // The inbound is gone with the rest of the log; the clear just happened, so the stock is
      // aged from there — not from a creation date 200 days back.
      const report = await reports.stockAging(now);
      const byLabel = Object.fromEntries(report.buckets.map((b) => [b.label, b.itemCount]));
      expect(byLabel['0–30 days']).toBe(1);
      expect(byLabel['180+ days']).toBe(0);
    });

    it('keeps a recorded acquisition date ahead of a cleared log', async () => {
      const now = Date.now();
      const item = await items.create({ name: 'Heirloom', quantity: 1, unitCost: 1 });
      await driver.execute('UPDATE items SET acquired_at = ? WHERE id = ?;', [
        new Date(now - 400 * MS_PER_DAY).toISOString(),
        item.id,
      ]);

      await items.clearHistory(item.id, 'Device');

      // The acquisition date survives the clear and still describes the stock, so it wins.
      const report = await reports.stockAging(now);
      const byLabel = Object.fromEntries(report.buckets.map((b) => [b.label, b.itemCount]));
      expect(byLabel['180+ days']).toBe(1);
      expect(byLabel['0–30 days']).toBe(0);
    });

    it('values on-hand stock the same way as the valuation headline (issue #397)', async () => {
      const now = Date.now();
      // A revalued collectible: the manual current value wins over its cost, on both figures.
      await items.create({ name: 'Collectible', quantity: 1, unitCost: 40, currentValue: 900 });
      // An unlimited source holds no finite value and no meaningful age, so neither figure
      // counts it — nor does it inflate the aging report's quantity or item counts.
      await items.create({ name: 'Mains water', quantity: 500, unitCost: 2, isUnlimited: true });

      const headline = (await reports.inventoryValue()).totalValue;
      const report = await reports.stockAging(now);
      expect(headline).toBe(900);
      expect(report.totalValue).toBe(headline);
      expect(report.totalQuantity).toBe(1); // the unlimited 500 is excluded, not aged
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

    it('anchors on the same total as the valuation headline (issue #289)', async () => {
      const now = Date.now();
      // A revalued collectible: the manual current value wins over its cost, on both figures.
      await items.create({ name: 'Collectible', quantity: 1, unitCost: 40, currentValue: 900 });
      // An unlimited source holds no finite value, so neither figure counts it.
      await items.create({ name: 'Mains water', quantity: 500, unitCost: 2, isUnlimited: true });

      const headline = (await reports.inventoryValue()).totalValue;
      const trend = await reports.valuationTrend(30, 4, now);
      expect(headline).toBe(900);
      expect(trend.endValue).toBe(headline);
    });

    it('values in-window movements the same way it values the anchor (issue #289)', async () => {
      const now = Date.now();
      const item = await items.create({
        name: 'Collectible',
        quantity: 1,
        unitCost: 40,
        currentValue: 900,
      });
      // A −1 consumption mid-window is worth £900, not the £40 replacement cost, so the
      // reconstructed start value is the £1,800 the headline would have reported back then.
      await addHistory(item.id, -1, now - 15 * MS_PER_DAY);

      const report = await reports.valuationTrend(30, 4, now);
      expect(report.endValue).toBe(900);
      expect(report.startValue).toBe(1800);
    });

    it('leaves unlimited sources out of the reconstructed movements (issue #289)', async () => {
      const now = Date.now();
      const water = await items.create({ name: 'Mains water', quantity: 500, unitCost: 2 });
      await addHistory(water.id, -100, now - 15 * MS_PER_DAY);
      await driver.execute('UPDATE items SET is_unlimited = 1 WHERE id = ?;', [water.id]);

      const report = await reports.valuationTrend(30, 4, now);
      expect(report.endValue).toBe(0);
      expect(report.startValue).toBe(0);
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
      await supplierParts.create(dupA.id, {
        supplier: { supplierName: 'Pref Co' },
        unitCost: 0.5,
        isPreferred: true,
      });
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

    it('does not flag an item priced only by a manual current value (issue #706)', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      // Priced by a revaluation and nothing else — every valuation surface prices it at 900, so
      // "Missing price" would send the user to fix something that is not broken.
      const revalued = await items.create({
        name: 'Collectible',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
        currentValue: 900,
      });
      // A deliberate "worth nothing" mark is a price too, exactly as valuation reads it.
      const worthless = await items.create({
        name: 'Keepsake',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
        currentValue: 0,
      });
      const unpriced = await items.create({
        name: 'Unpriced',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
      });

      const report = await reports.dataHygiene(180);
      // Exactly one of the three is unpriced: neither the revaluation nor the deliberate zero is.
      expect(sampleIds(report, 'missing-price')).toEqual([unpriced.id]);
      expect(revalued.id).not.toBe(worthless.id); // the fixtures really are three distinct items
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
      // An acquired asset: purchase_price 500 on 2026-06-10 (inside the 90-day window). Money
      // columns are seeded in stored micro-units (issue #286), via `toStoredMoney`.
      await driver.execute(
        `INSERT INTO items (id, name, location_id, category_id, quantity, purchase_price, acquired_at)
         VALUES ('it-1', 'Scope', ?, 'cat-r', 1, ${toStoredMoney(500)}, '2026-06-10');`,
        [UNASSIGNED_LOCATION_ID],
      );
      // A received PO line: 5 received @ £2 = £10 from supplier "RS", ordered 5 days ago.
      const rs = await suppliers.resolveOrCreate('RS');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES ('po-1', ?, 'RECEIVED', ?);",
        [rs.id, day(-5)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-1', 'po-1', 'it-1', 5, 5, ${toStoredMoney(2)});`,
      );
      // A manual project expense: £30, incurred 3 days ago.
      await driver.execute("INSERT INTO projects (id, name) VALUES ('pr-1', 'Build');");
      await driver.execute(
        `INSERT INTO project_expenses (id, project_id, amount, incurred_at) VALUES ('ex-1', 'pr-1', ${toStoredMoney(30)}, ?);`,
        [day(-3)],
      );
      // An OUT-OF-WINDOW received PO (400 days ago) — must be excluded.
      const old = await suppliers.resolveOrCreate('Old');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES ('po-old', ?, 'RECEIVED', ?);",
        [old.id, day(-400)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-old', 'po-old', 'it-1', 100, 100, ${toStoredMoney(9)});`,
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
      const rs = await suppliers.resolveOrCreate('RS');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES ('po-2', ?, 'ORDERED', ?);",
        [rs.id, day(-2)],
      );
      // received_qty 0 → no spend yet.
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-2', 'po-2', 5, 0, ${toStoredMoney(2)});`,
      );
      const report = await reports.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(0);
      expect(report.eventCount).toBe(0);
      expect(report.bySupplier).toEqual([]);
      expect(report.bySource.every((s) => s.total === 0)).toBe(true);
      expect(report.excludedForeignCurrency).toBe(0);
    });

    it('excludes a purchase order priced in another currency, and reports the count (issue #285)', async () => {
      // Gubbins holds no exchange rates, so a $500 order and a £500 order are not £1,000 —
      // in the headline, nor in the by-supplier and by-category totals that recompose it.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      await driver.execute("INSERT INTO categories (id, name) VALUES ('cat-r', 'Resistors');");
      await driver.execute(
        `INSERT INTO items (id, name, location_id, category_id, quantity)
         VALUES ('it-1', 'Resistor', ?, 'cat-r', 1);`,
        [UNASSIGNED_LOCATION_ID],
      );

      const home = await suppliers.resolveOrCreate('Home Co');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-gbp', ?, 'RECEIVED', ?, 'GBP');",
        [home.id, day(-5)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-gbp', 'po-gbp', 'it-1', 1, 1, ${toStoredMoney(500)});`,
      );

      const abroad = await suppliers.resolveOrCreate('Stateside Inc');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-usd', ?, 'RECEIVED', ?, 'USD');",
        [abroad.id, day(-4)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-usd', 'po-usd', 'it-1', 1, 1, ${toStoredMoney(500)});`,
      );

      const report = await gbp.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(500); // the £ order only — never £1,000
      expect(report.eventCount).toBe(1);
      expect(report.bySupplier.map((g) => [g.name, g.total])).toEqual([['Home Co', 500]]);
      expect(report.byCategory.map((g) => [g.name, g.total])).toEqual([['Resistors', 500]]);
      // …and the omission is reported rather than left as a silent hole in the total.
      expect(report.excludedForeignCurrency).toBe(1);
    });

    it('counts an order as base-currency when its code is blank, or scruffily cased (issue #285)', async () => {
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      await driver.execute(
        "INSERT INTO items (id, name, location_id, quantity) VALUES ('it-1', 'Resistor', ?, 1);",
        [UNASSIGNED_LOCATION_ID],
      );
      const rs = await suppliers.resolveOrCreate('RS');
      // NULL (the documented "base currency" convention), and a padded lower-case code.
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES ('po-null', ?, 'RECEIVED', ?);",
        [rs.id, day(-5)],
      );
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-scruffy', ?, 'RECEIVED', ?, ' gbp ');",
        [rs.id, day(-4)],
      );
      for (const po of ['po-null', 'po-scruffy']) {
        await driver.execute(
          `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
           VALUES (?, ?, 'it-1', 1, 1, ${toStoredMoney(10)});`,
          [`pol-${po}`, po],
        );
      }

      const report = await gbp.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(20);
      expect(report.excludedForeignCurrency).toBe(0);
    });

    it('does not count a foreign order whose supplier was deleted as currency-excluded (issue #285)', async () => {
      // Spend resolves suppliers with an inner join, so an order that lost its supplier
      // (ON DELETE SET NULL) contributes nothing whatever its currency. Counting it would claim
      // money is missing that the currency filter never removed.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      await driver.execute(
        "INSERT INTO items (id, name, location_id, quantity) VALUES ('it-1', 'Resistor', ?, 1);",
        [UNASSIGNED_LOCATION_ID],
      );
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-orphan', NULL, 'RECEIVED', ?, 'USD');",
        [day(-4)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-orphan', 'po-orphan', 'it-1', 1, 1, ${toStoredMoney(500)});`,
      );

      const report = await gbp.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(0);
      expect(report.excludedForeignCurrency).toBe(0);
    });

    it('treats a whitespace-only currency code as the base currency (issue #285)', async () => {
      // A blank code names no currency. Sync and import can land one the entry dialogs would
      // have trimmed away, and dropping the order for it would understate spend for no reason.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      await driver.execute(
        "INSERT INTO items (id, name, location_id, quantity) VALUES ('it-1', 'Resistor', ?, 1);",
        [UNASSIGNED_LOCATION_ID],
      );
      const rs = await suppliers.resolveOrCreate('RS');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-blank', ?, 'RECEIVED', ?, '   ');",
        [rs.id, day(-4)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-blank', 'po-blank', 'it-1', 1, 1, ${toStoredMoney(40)});`,
      );

      const report = await gbp.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(40);
      expect(report.excludedForeignCurrency).toBe(0);
    });

    it('excludes nothing when the base currency is unknown (issue #285)', async () => {
      // An unknown base cannot tell foreign from domestic; failing open preserves the previous
      // behaviour rather than blanking every total — and nothing is claimed to be excluded.
      await driver.execute(
        "INSERT INTO items (id, name, location_id, quantity) VALUES ('it-1', 'Resistor', ?, 1);",
        [UNASSIGNED_LOCATION_ID],
      );
      const abroad = await suppliers.resolveOrCreate('Stateside Inc');
      await driver.execute(
        "INSERT INTO purchase_orders (id, supplier_id, status, ordered_at, currency) VALUES ('po-usd', ?, 'RECEIVED', ?, 'USD');",
        [abroad.id, day(-4)],
      );
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty, received_qty, unit_cost)
         VALUES ('pol-usd', 'po-usd', 'it-1', 1, 1, ${toStoredMoney(500)});`,
      );

      const report = await reports.spendAnalytics(90, 10, NOW);
      expect(report.total).toBe(500);
      expect(report.excludedForeignCurrency).toBe(0);
    });
  });

  describe('insuranceScheduleSummary', () => {
    /** Read every group's lines by paging, so a test can assert on the whole document. */
    async function readAllLines(includePhotos = false) {
      const summary = await reports.insuranceScheduleSummary();
      const groups = await Promise.all(
        summary.groups.map(async (g) => ({
          group: g,
          lines: (await reports.insuranceScheduleGroupPage(g.locationId, { limit: 100 }, { includePhotos }))
            .rows,
        })),
      );
      return { summary, groups };
    }

    it('groups active assets by home location in hierarchy order with subtotals', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf A', parentId: garage.id });

      await items.create({ name: 'Drill', locationId: garage.id, quantity: 1, unitCost: 100 });
      await items.create({ name: 'Saw', locationId: shelf.id, quantity: 2, unitCost: 25 });

      const summary = await reports.insuranceScheduleSummary();

      // Depth-first order: Garage (root) then its child Shelf A.
      expect(summary.groups.map((g) => g.locationPath)).toEqual(['Garage', 'Garage › Shelf A']);
      const garageGroup = summary.groups.find((g) => g.locationId === garage.id)!;
      const shelfGroup = summary.groups.find((g) => g.locationId === shelf.id)!;
      expect(garageGroup.subtotal).toBe(100);
      expect(garageGroup.itemCount).toBe(1);
      expect(shelfGroup.subtotal).toBe(50); // 2 × £25
      expect(summary.grandTotal).toBe(150);
      expect(summary.itemCount).toBe(2);
    });

    it('excludes soft-deleted items, abstract variant parents and unlimited-supply items', async () => {
      const parent = await items.create({ name: 'Kit', trackingMode: 'SERIALISED' });
      await items.createVariant(parent.id, { name: 'Kit v2' }); // makes the parent abstract
      const removed = await items.create({ name: 'Gone', quantity: 1, unitCost: 5 });
      await items.softDelete(removed.id);
      await items.create({ name: 'Mains water', quantity: 1, unitCost: 3, isUnlimited: true });
      const keep = await items.create({ name: 'Camera', quantity: 1, unitCost: 400 });

      const { summary, groups } = await readAllLines();
      const names = groups.flatMap((g) => g.lines.map((l) => l.name)).sort();
      // The child variant "Kit v2" is a real unit and stays; only the abstract parent,
      // the soft-deleted item and the unlimited source drop out.
      expect(names).toEqual(['Camera', 'Kit v2']);
      expect(summary.itemCount).toBe(2);
      expect(groups.flatMap((g) => g.lines).find((l) => l.id === keep.id)?.replacementValue).toBe(400);
    });

    it('groups location-less items under the system Unassigned location', async () => {
      await items.create({ name: 'Floating', quantity: 1, unitCost: 9 });
      const { summary, groups } = await readAllLines();
      const unassigned = groups.find((g) => g.group.locationId === UNASSIGNED_LOCATION_ID);
      expect(unassigned?.lines.map((l) => l.name)).toEqual(['Floating']);
      expect(summary.grandTotal).toBe(9);
    });

    it('declines a preferred supplier price quoted in another currency', async () => {
      // The #284 refusal must survive the move to a streamed scan: a foreign price is excluded
      // rather than mis-summed into a base-currency total.
      const gbp = new ReportRepository(driver, { resolveBaseCurrency: () => 'GBP' });
      const shelf = await locations.create({ name: 'Study' });
      const foreign = await items.create({
        name: 'Scope',
        locationId: shelf.id,
        quantity: 1,
        unitCost: null,
      });
      await supplierParts.create(foreign.id, {
        supplier: { supplierName: 'Akihabara Denshi' },
        unitCost: 9800,
        currency: 'JPY',
        isPreferred: true,
      });
      await items.create({ name: 'Desk', locationId: shelf.id, quantity: 1, unitCost: 150 });

      const summary = await gbp.insuranceScheduleSummary();
      expect(summary.grandTotal).toBe(150);
    });

    it('totals a fixture larger than one scan chunk without dropping or double-counting', async () => {
      // The keyset loop's boundary: 2001 assets is one full chunk plus one.
      const room = await locations.create({ name: 'Warehouse' });
      for (let i = 0; i < 2001; i += 1) {
        await items.create({ name: `Asset ${i}`, locationId: room.id, quantity: 1, unitCost: 1 });
      }

      const summary = await reports.insuranceScheduleSummary();
      expect(summary.itemCount).toBe(2001);
      expect(summary.grandTotal).toBe(2001);
      expect(summary.groups.find((g) => g.locationId === room.id)!.itemCount).toBe(2001);
    });

    it('is empty for an empty database', async () => {
      const summary = await reports.insuranceScheduleSummary();
      expect(summary.groups).toEqual([]);
      expect(summary.grandTotal).toBe(0);
      expect(summary.itemCount).toBe(0);
    });
  });

  describe('insuranceScheduleGroupPage', () => {
    it('orders a room by name and pages without gaps or repeats', async () => {
      const room = await locations.create({ name: 'Study' });
      for (const name of ['Delta', 'alpha', 'Charlie', 'bravo']) {
        await items.create({ name, locationId: room.id, quantity: 1, unitCost: 1 });
      }

      const first = await reports.insuranceScheduleGroupPage(room.id, { limit: 2, offset: 0 });
      const second = await reports.insuranceScheduleGroupPage(room.id, { limit: 2, offset: 2 });

      // Case-insensitive, matching the document's own ordering.
      expect(first.rows.map((l) => l.name)).toEqual(['alpha', 'bravo']);
      expect(second.rows.map((l) => l.name)).toEqual(['Charlie', 'Delta']);
      // `hasMore` follows the repository-wide contract — "a full page came back" — so an exactly
      // full *final* page still reports true. The schedule never navigates by it: the summary's
      // per-group `itemCount` is the authority, which is why a page can be addressed directly
      // rather than discovered by walking.
      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(true);

      const third = await reports.insuranceScheduleGroupPage(room.id, { limit: 2, offset: 4 });
      expect(third.rows).toEqual([]);
      expect(third.hasMore).toBe(false);
    });

    it('reports no more rows once the group is exhausted', async () => {
      const room = await locations.create({ name: 'Shed' });
      await items.create({ name: 'Spade', locationId: room.id, quantity: 1, unitCost: 4 });

      const past = await reports.insuranceScheduleGroupPage(room.id, { limit: 10, offset: 10 });
      expect(past.rows).toEqual([]);
      expect(past.hasMore).toBe(false);
    });

    it('fetches the thumbnail only when photos are requested', async () => {
      const room = await locations.create({ name: 'Loft' });
      const drill = await items.create({ name: 'Drill', locationId: room.id, quantity: 1, unitCost: 100 });
      const images = new ImageRepository(driver);
      await images.add({
        itemId: drill.id,
        thumbnailBlob: new Uint8Array([1, 2, 3]),
        fullResOpfsPath: '/d.webp',
      });

      const withPhotos = await reports.insuranceScheduleGroupPage(
        room.id,
        { limit: 10 },
        { includePhotos: true },
      );
      expect(withPhotos.rows[0]!.thumbnail).toBeInstanceOf(Uint8Array);

      // The actual fix (issue #163): with photos off the BLOB is never selected at all, not
      // merely discarded after the worker has already materialised and transferred it.
      const sql: string[] = [];
      const query = driver.query.bind(driver);
      driver.query = ((text: string, params?: unknown) => {
        sql.push(text);
        return query(text, params as never);
      }) as typeof driver.query;

      const withoutPhotos = await reports.insuranceScheduleGroupPage(
        room.id,
        { limit: 10 },
        { includePhotos: false },
      );
      driver.query = query;

      expect(withoutPhotos.rows[0]!.thumbnail).toBeNull();
      expect(sql.some((s) => s.includes('thumbnail_blob FROM item_images'))).toBe(false);
      expect(sql.some((s) => s.includes('NULL AS thumbnail_blob'))).toBe(true);
    });

    it('clamps an over-large page request to the repository ceiling', async () => {
      const room = await locations.create({ name: 'Cellar' });
      await items.create({ name: 'Rack', locationId: room.id, quantity: 1, unitCost: 1 });

      const page = await reports.insuranceScheduleGroupPage(room.id, { limit: 5000 });
      expect(page.limit).toBe(100);
    });
  });

  describe('partsCatalogue', () => {
    it('for the "all" scope groups every active item by location, excluding variant parents and removed items', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf A', parentId: garage.id });
      await items.create({ name: 'Anvil', locationId: garage.id, quantity: 1, unitCost: 10 });
      await items.create({ name: 'Widget', locationId: shelf.id, quantity: 3, unitCost: 2 });

      const parent = await items.create({ name: 'Kit', trackingMode: 'SERIALISED' });
      await items.createVariant(parent.id, { name: 'Kit v2' }); // makes the parent abstract
      const removed = await items.create({ name: 'Gone', quantity: 1 });
      await items.softDelete(removed.id);

      const catalogue = await reports.partsCatalogue({ kind: 'all' });
      const names = catalogue.groups.flatMap((g) => g.lines.map((l) => l.name)).sort();
      // The abstract parent and the soft-deleted item drop out; the real variant stays.
      expect(names).toEqual(['Anvil', 'Kit v2', 'Widget']);
      expect(catalogue.groups.find((g) => g.groupId === shelf.id)?.subtotal).toBe(6);
      expect(catalogue.grandTotal).toBe(16);
      expect(catalogue.totalQuantity).toBe(4); // 1 anvil + 3 widget (the new variant holds 0)
      expect(catalogue.hasValue).toBe(true);
    });

    it('prices a revalued asset at its current value, agreeing with the insurance schedule (issue #706)', async () => {
      const garage = await locations.create({ name: 'Garage' });
      // Priced only by a revaluation: the catalogue used to select no `current_value`, so this
      // line printed a dash and added nothing to the totals while the schedule listed it at 900.
      const coin = await items.create({
        name: 'Coin',
        locationId: garage.id,
        quantity: 2,
        unitCost: null,
        currentValue: 900,
      });
      // And it still outranks the sources beneath it, as it does on every other valuation surface.
      await items.create({
        name: 'Guitar',
        locationId: garage.id,
        quantity: 1,
        unitCost: 300,
        currentValue: 1200,
      });

      const catalogue = await reports.partsCatalogue({ kind: 'all' });
      const lines = catalogue.groups.flatMap((g) => g.lines);
      expect(lines.find((l) => l.id === coin.id)).toMatchObject({ unitCost: 900, lineValue: 1800 });
      expect(lines.find((l) => l.name === 'Guitar')).toMatchObject({ unitCost: 1200, lineValue: 1200 });
      expect(catalogue.grandTotal).toBe(3000);
      expect(catalogue.hasValue).toBe(true);
    });

    it('counts a scope without fetching it, describing exactly the set the document would (issue #338)', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf A', parentId: garage.id });
      const kitchen = await locations.create({ name: 'Kitchen' });
      await items.create({ name: 'Anvil', locationId: garage.id, quantity: 1 });
      await items.create({ name: 'Widget', locationId: shelf.id, quantity: 1 });
      await items.create({ name: 'Kettle', locationId: kitchen.id, quantity: 1 });

      // A variant parent is abstract and a removed item is gone — neither is counted, exactly as
      // neither is catalogued. The count and the document must never describe different sets.
      const parent = await items.create({ name: 'Kit', trackingMode: 'SERIALISED' });
      await items.createVariant(parent.id, { name: 'Kit v2' });
      const removed = await items.create({ name: 'Gone', quantity: 1 });
      await items.softDelete(removed.id);

      for (const scope of [
        { kind: 'all' } as const,
        { kind: 'location', locationId: garage.id } as const,
        { kind: 'items', itemIds: [] } as const,
      ]) {
        const catalogue = await reports.partsCatalogue(scope);
        expect(await reports.partsCatalogueCount(scope)).toBe(catalogue.itemCount);
      }
      expect(await reports.partsCatalogueCount({ kind: 'all' })).toBe(4); // Anvil, Widget, Kettle, Kit v2
      expect(await reports.partsCatalogueCount({ kind: 'location', locationId: garage.id })).toBe(2);
      expect(await reports.partsCatalogueCount({ kind: 'items', itemIds: [] })).toBe(0);
    });

    it('for the "location" scope includes the whole subtree but nothing outside it', async () => {
      const garage = await locations.create({ name: 'Garage' });
      const shelf = await locations.create({ name: 'Shelf A', parentId: garage.id });
      const kitchen = await locations.create({ name: 'Kitchen' });
      await items.create({ name: 'Anvil', locationId: garage.id, quantity: 1 });
      await items.create({ name: 'Widget', locationId: shelf.id, quantity: 1 });
      await items.create({ name: 'Kettle', locationId: kitchen.id, quantity: 1 });

      const catalogue = await reports.partsCatalogue({ kind: 'location', locationId: garage.id });
      const names = catalogue.groups.flatMap((g) => g.lines.map((l) => l.name)).sort();
      expect(names).toEqual(['Anvil', 'Widget']); // Kettle is in a different root — excluded
    });

    it('for the "project" scope includes only the items referenced by the project BOM', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const inBom = await items.create({ name: 'Resistor', locationId: shelf.id, quantity: 100 });
      await items.create({ name: 'Unrelated', locationId: shelf.id, quantity: 1 });

      await driver.execute("INSERT INTO projects (id, name) VALUES ('proj-1', 'Amplifier');");
      await driver.execute(
        `INSERT INTO project_bom_lines (id, project_id, item_id, required_qty) VALUES ('bl-1', 'proj-1', ?, 5);`,
        [inBom.id],
      );

      const catalogue = await reports.partsCatalogue({ kind: 'project', projectId: 'proj-1' });
      const names = catalogue.groups.flatMap((g) => g.lines.map((l) => l.name));
      expect(names).toEqual(['Resistor']);
    });

    it('for the "items" scope includes exactly the listed items, and an empty list yields nothing', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const a = await items.create({ name: 'Alpha', locationId: shelf.id, quantity: 1 });
      await items.create({ name: 'Beta', locationId: shelf.id, quantity: 1 });

      const chosen = await reports.partsCatalogue({ kind: 'items', itemIds: [a.id] });
      expect(chosen.groups.flatMap((g) => g.lines.map((l) => l.name))).toEqual(['Alpha']);

      const none = await reports.partsCatalogue({ kind: 'items', itemIds: [] });
      expect(none.itemCount).toBe(0);
      expect(none.groups).toEqual([]);
    });

    it('resolves the preferred supplier name and cost onto the line (falling back to it when no manual cost)', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const item = await items.create({ name: 'Cap', locationId: shelf.id, quantity: 2, unitCost: null });
      await supplierParts.create(item.id, {
        supplier: { supplierName: 'Parts Co' },
        unitCost: 4,
        isPreferred: true,
      });

      const catalogue = await reports.partsCatalogue({ kind: 'items', itemIds: [item.id] });
      const line = catalogue.groups[0].lines[0];
      expect(line.supplier).toBe('Parts Co');
      expect(line.unitCost).toBe(4);
      expect(line.lineValue).toBe(8);
    });

    it('carries the item description, and only fetches the thumbnail when photos are requested', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const item = await items.create({
        name: 'Cap',
        locationId: shelf.id,
        description: 'A 10µF capacitor',
        quantity: 1,
      });
      const images = new ImageRepository(driver);
      await images.add({
        itemId: item.id,
        thumbnailBlob: new Uint8Array([9, 9]),
        fullResOpfsPath: '/c.webp',
      });

      const noPhotos = await reports.partsCatalogue({ kind: 'items', itemIds: [item.id] });
      expect(noPhotos.groups[0].lines[0].description).toBe('A 10µF capacitor');
      expect(noPhotos.groups[0].lines[0].thumbnail).toBeNull(); // not fetched by default

      const withPhotos = await reports.partsCatalogue(
        { kind: 'items', itemIds: [item.id] },
        { includePhotos: true },
      );
      expect(withPhotos.groups[0].lines[0].thumbnail).toBeInstanceOf(Uint8Array);
    });

    it('groups by category when asked', async () => {
      const shelf = await locations.create({ name: 'Shelf A' });
      const caps = await categories.create({ name: 'Capacitors' });
      const res = await categories.create({ name: 'Resistors' });
      await items.create({ name: 'Cap', locationId: shelf.id, categoryId: caps.id, quantity: 1 });
      await items.create({ name: 'Res', locationId: shelf.id, categoryId: res.id, quantity: 1 });

      const catalogue = await reports.partsCatalogue({ kind: 'all' }, { groupBy: 'category' });
      expect(catalogue.groups.map((g) => g.groupLabel)).toEqual(['Capacitors', 'Resistors']);
    });
  });
});
