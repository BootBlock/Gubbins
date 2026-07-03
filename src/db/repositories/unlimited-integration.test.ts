import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { ProjectRepository } from './ProjectRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ReportRepository } from './ReportRepository';

/**
 * Phase 82 — unlimited-supply items, exercised through the real repositories against a
 * `:memory:` database (the pure rules live in `unlimited.ts`/`reorder-policy.ts` tests).
 * These lock the repository-level contract: the flag round-trips, an infinite source is
 * excluded from low-stock/valuation/checkout, and consuming one in an assembly logs
 * `CONSUMED` without ever depleting or retiring it.
 */
describe('unlimited-supply integration', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let projects: ProjectRepository;
  let checkouts: CheckoutRepository;
  let reports: ReportRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    projects = new ProjectRepository(driver);
    checkouts = new CheckoutRepository(driver);
    reports = new ReportRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('round-trips the is_unlimited flag through create and getById', async () => {
    const water = await items.create({ name: 'Tap water', isUnlimited: true, quantity: 0 });
    expect(water.isUnlimited).toBe(true);
    const reloaded = await items.getById(water.id);
    expect(reloaded?.isUnlimited).toBe(true);

    const normal = await items.create({ name: 'M3 bolt', quantity: 5 });
    expect(normal.isUnlimited).toBe(false);
  });

  it('refuses to mark a non-DISCRETE item as unlimited (mirrors the DB CHECK)', async () => {
    await expect(
      items.create({ name: 'Serial thing', trackingMode: 'SERIALISED', isUnlimited: true }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('can toggle unlimited on and off via update without touching quantity', async () => {
    const item = await items.create({ name: 'Zip ties', quantity: 200 });
    const on = await items.update(item.id, { isUnlimited: true });
    expect(on.isUnlimited).toBe(true);
    expect(on.quantity).toBe(200); // lossless — the stored count is untouched
    const off = await items.update(item.id, { isUnlimited: false });
    expect(off.isUnlimited).toBe(false);
    expect(off.quantity).toBe(200);
  });

  it('excludes unlimited items from the low-stock feed', async () => {
    await items.create({ name: 'Empty finite', quantity: 0 });
    await items.create({ name: 'Empty unlimited', quantity: 0, isUnlimited: true });

    const low = await items.listLowStock({ qtyThreshold: 5 });
    const names = low.rows.map((r) => r.name);
    expect(names).toContain('Empty finite');
    expect(names).not.toContain('Empty unlimited');
  });

  it('blocks checking out an unlimited item', async () => {
    const water = await items.create({ name: 'Tap water', isUnlimited: true });
    await expect(checkouts.checkout({ itemId: water.id, contactName: 'Alex' })).rejects.toThrow(/unlimited/i);
  });

  it('excludes unlimited items from inventory valuation', async () => {
    await items.create({ name: 'Priced finite', quantity: 3, unitCost: 2 }); // value 6
    await items.create({ name: 'Priced unlimited', quantity: 10, unitCost: 5, isUnlimited: true });

    const report = await reports.inventoryValue();
    expect(report.totalValue).toBe(6);
  });

  it('consuming an unlimited BOM component logs CONSUMED, never depletes, and never shortfalls', async () => {
    const water = await items.create({ name: 'Tap water', isUnlimited: true });
    const project = await projects.create({ name: 'Coolant loop' });
    await projects.addLine(project.id, { itemId: water.id, requiredQty: 1000 });

    // Never a shortfall: an infinite source is always satisfiable, so it stays off the list.
    const shopping = await projects.getShoppingList(project.id);
    expect(shopping.some((e) => e.itemId === water.id)).toBe(false);

    await projects.finaliseAssembly(project.id, { outcome: 'PERMANENT_CONSUMPTION' });

    // The infinite source survives (still active) — consumption never retires it…
    const after = await items.getById(water.id);
    expect(after?.isActive).toBe(true);
    // …but a CONSUMED entry is still written for the activity trail.
    const history = await items.getHistory(water.id);
    expect(history.rows.some((h) => h.action === 'CONSUMED')).toBe(true);
  });
});
