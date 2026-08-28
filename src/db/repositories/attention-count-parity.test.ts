import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CheckoutRepository } from './CheckoutRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { ReportRepository } from './ReportRepository';

/**
 * The attention feeds' totals count exactly what their feeds return (issue #606).
 *
 * Each of these feeds is read one bounded page at a time, and the dashboard widgets, the alert
 * centre and the Contacts summary all state a figure over the rows. That figure now comes from a
 * separate `COUNT(*)`, so the two are only trustworthy together: a count that answers a slightly
 * different question is a wrong total presented with more authority than the old `rows.length`
 * ever had.
 *
 * These drive **both sides over the same dataset** and compare, rather than comparing their SQL
 * text — every count shares its feed's predicate fragment, and this is what fails if one of them
 * is ever edited alone. Each case seeds rows that are deliberately *excluded* as well as rows
 * that match, so a count that dropped a guard (the variant-parent exclusion, the unlimited-supply
 * exclusion, the returned-loan scope) diverges rather than agreeing by accident.
 */
describe('attention feeds — every total counts what its feed returns (issue #606)', () => {
  const NOW = Date.parse('2026-06-30T12:00:00Z');
  const DAY = 86_400_000;

  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;
  let maintenance: MaintenanceRepository;
  let checkouts: CheckoutRepository;
  let reports: ReportRepository;
  let drawerId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    checkouts = new CheckoutRepository(driver);
    reports = new ReportRepository(driver);
    drawerId = (await locations.create({ name: 'Drawer A' })).id;
  });

  afterEach(async () => {
    await driver.close();
  });

  /** `ms` as the 'YYYY-MM-DD' string the warranty column stores. */
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('lowStockCount matches listLowStock', async () => {
    const thresholds = { qtyThreshold: 5, gaugePercent: 0 };
    // Two genuinely low, and three that each trip a different exclusion the predicate carries.
    await items.create({ name: 'Low bolts', quantity: 2, locationId: drawerId });
    await items.create({ name: 'Low nuts', quantity: 0, locationId: drawerId });
    await items.create({ name: 'Plenty', quantity: 500, locationId: drawerId });
    await items.create({ name: 'Endless', quantity: 0, locationId: drawerId, isUnlimited: true });
    const parent = await items.create({ name: 'Abstract parent', quantity: 0, locationId: drawerId });
    await items.createVariant(parent.id, { name: 'Variant', quantity: 1, locationId: drawerId });

    const page = await items.listLowStock(thresholds, { limit: 100 });
    await expect(reports.lowStockCount(thresholds)).resolves.toBe(page.rows.length);
    expect(page.rows.map((r) => r.name).sort()).toEqual(['Low bolts', 'Low nuts', 'Variant']);
  });

  it('countExpiringWithin matches listExpiringWithin', async () => {
    await items.create({ name: 'Lapsed', quantity: 1, locationId: drawerId, expiryDate: NOW - 30 * DAY });
    await items.create({ name: 'Soon', quantity: 1, locationId: drawerId, expiryDate: NOW + 3 * DAY });
    await items.create({ name: 'Far off', quantity: 1, locationId: drawerId, expiryDate: NOW + 400 * DAY });
    await items.create({ name: 'Undated', quantity: 1, locationId: drawerId });
    // Soft-deleted, so neither side may see it — the `is_active` scope is a guard the count
    // carries separately from the shared predicate, and is the one this case would miss.
    const gone = await items.create({
      name: 'Removed',
      quantity: 1,
      locationId: drawerId,
      expiryDate: NOW - DAY,
    });
    await items.softDelete(gone.id);

    const page = await items.listExpiringWithin(30, NOW, { limit: 100 });
    await expect(items.countExpiringWithin(30, NOW)).resolves.toBe(page.rows.length);
    expect(page.rows.map((r) => r.name)).toEqual(['Lapsed', 'Soon']);
  });

  it('countWarrantyExpiring matches listWarrantyExpiring', async () => {
    await items.create({
      name: 'Warranty lapsed',
      quantity: 1,
      locationId: drawerId,
      warrantyExpiresAt: isoDay(NOW - 10 * DAY),
    });
    await items.create({
      name: 'Warranty soon',
      quantity: 1,
      locationId: drawerId,
      warrantyExpiresAt: isoDay(NOW + 10 * DAY),
    });
    await items.create({
      name: 'Warranty years off',
      quantity: 1,
      locationId: drawerId,
      warrantyExpiresAt: isoDay(NOW + 900 * DAY),
    });
    await items.create({ name: 'No warranty', quantity: 1, locationId: drawerId });

    const page = await items.listWarrantyExpiring(30, NOW, { limit: 100 });
    await expect(items.countWarrantyExpiring(30, NOW)).resolves.toBe(page.rows.length);
    expect(page.rows.map((r) => r.name)).toEqual(['Warranty lapsed', 'Warranty soon']);
  });

  it('countDue matches listDue', async () => {
    // A schedule's due instant is measured from its last service, else from when it was created
    // — which is the real clock, not `NOW` — so both are serviced explicitly and graded against
    // that same real instant.
    const at = Date.now();
    const drill = await items.create({ name: 'Drill', quantity: 1, locationId: drawerId });
    const saw = await items.create({ name: 'Saw', quantity: 1, locationId: drawerId });
    const service = await maintenance.create({
      itemId: drill.id,
      name: 'Service',
      basis: 'TIME',
      intervalDays: 1,
    });
    const sharpen = await maintenance.create({
      itemId: saw.id,
      name: 'Sharpen',
      basis: 'TIME',
      intervalDays: 365,
    });
    await maintenance.logPerformed(service.id, at - 30 * DAY, 'overdue by weeks');
    await maintenance.logPerformed(sharpen.id, at - DAY, 'done yesterday');

    const page = await maintenance.listDue(at, { limit: 100 });
    await expect(maintenance.countDue(at)).resolves.toBe(page.rows.length);
    expect(page.rows.map((r) => r.itemName)).toEqual(['Drill']);
  });

  it('countOpen matches listOpen, and its overdue arm matches the same rule the rows carry', async () => {
    const late = await items.create({ name: 'Late tool', quantity: 3, locationId: drawerId });
    const soon = await items.create({ name: 'Due later', quantity: 3, locationId: drawerId });
    const undated = await items.create({ name: 'No due date', quantity: 3, locationId: drawerId });
    await checkouts.checkout({ itemId: late.id, contactName: 'Ada', quantity: 1, dueDate: NOW - DAY });
    await checkouts.checkout({ itemId: soon.id, contactName: 'Ada', quantity: 1, dueDate: NOW + DAY });
    await checkouts.checkout({ itemId: undated.id, contactName: 'Ada', quantity: 1 });
    // A returned loan is not open, so neither figure may include it.
    const returned = await checkouts.checkout({ itemId: soon.id, contactName: 'Grace', quantity: 1 });
    await checkouts.checkIn(returned.id);

    const page = await checkouts.listOpen({ limit: 100 });
    const counts = await checkouts.countOpen(NOW);
    expect(counts.open).toBe(page.rows.length);
    expect(counts.overdue).toBe(page.rows.filter((r) => r.dueDate !== null && r.dueDate < NOW).length);
    expect(counts).toEqual({ open: 3, overdue: 1 });
  });

  it('countOpen reports zero on an empty loan board rather than NULL', async () => {
    await expect(checkouts.countOpen(NOW)).resolves.toEqual({ open: 0, overdue: 0 });
  });
});
