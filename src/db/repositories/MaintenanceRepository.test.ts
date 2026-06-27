import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { MaintenanceRepository } from './MaintenanceRepository';

const DAY = 86_400_000;

describe('MaintenanceRepository — Phase 9 (§4.3 Tool Maintenance)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let maintenance: MaintenanceRepository;
  let printerId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    printerId = (await items.create({ name: '3D printer', trackingMode: 'SERIALISED' })).id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates time- and usage-based schedules and lists them for an item', async () => {
    await maintenance.create({ itemId: printerId, name: 'Lube rails', basis: 'TIME', intervalDays: 90 });
    await maintenance.create({
      itemId: printerId,
      name: 'Replace nozzle',
      basis: 'USAGE',
      intervalUsage: 100,
      usageUnit: 'hours',
    });
    const list = await maintenance.listForItem(printerId);
    expect(list).toHaveLength(2);
    expect(list[0].basis).toBe('TIME');
    expect(list[1].usageUnit).toBe('hours');
  });

  it('rejects schedules missing the required interval for their basis', async () => {
    await expect(
      maintenance.create({ itemId: printerId, name: 'X', basis: 'TIME' }),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      maintenance.create({ itemId: printerId, name: 'X', basis: 'USAGE', intervalUsage: 0 }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('surfaces overdue TIME schedules and resets them on logPerformed', async () => {
    const sched = await maintenance.create({
      itemId: printerId,
      name: 'Lube rails',
      basis: 'TIME',
      intervalDays: 90,
    });
    // Backdate creation so it is already overdue.
    await driver.execute('UPDATE maintenance_schedules SET created_at = ? WHERE id = ?;', [
      Date.now() - 100 * DAY,
      sched.id,
    ]);
    const now = Date.now();
    expect(await maintenance.countDue(now)).toBe(1);
    const due = await maintenance.listDue(now);
    expect(due.rows[0].itemName).toBe('3D printer');

    await maintenance.logPerformed(sched.id, now, 'Lube rails performed (10 day(s) overdue).');
    expect(await maintenance.countDue(now)).toBe(0);

    const history = await items.getHistory(printerId);
    expect(history.rows.some((h) => h.action === 'MAINTENANCE_LOGGED')).toBe(true);
  });

  it('accrues usage and reports due once the interval is reached', async () => {
    const sched = await maintenance.create({
      itemId: printerId,
      name: 'Replace nozzle',
      basis: 'USAGE',
      intervalUsage: 100,
      usageUnit: 'hours',
    });
    const now = Date.now();
    expect(await maintenance.countDue(now)).toBe(0);
    await maintenance.addUsage(sched.id, 60);
    await maintenance.addUsage(sched.id, 50);
    const after = await maintenance.getById(sched.id);
    expect(after?.usageSinceService).toBe(110);
    expect(await maintenance.countDue(now)).toBe(1);

    await maintenance.logPerformed(sched.id, now, 'Nozzle replaced.');
    const reset = await maintenance.getById(sched.id);
    expect(reset?.usageSinceService).toBe(0);
  });

  it('refuses usage logging against a time-based schedule', async () => {
    const sched = await maintenance.create({
      itemId: printerId,
      name: 'Lube rails',
      basis: 'TIME',
      intervalDays: 90,
    });
    await expect(maintenance.addUsage(sched.id, 5)).rejects.toBeInstanceOf(DbError);
  });

  it('hard-deletes a schedule and records a tombstone', async () => {
    const sched = await maintenance.create({
      itemId: printerId,
      name: 'Lube rails',
      basis: 'TIME',
      intervalDays: 90,
    });
    await maintenance.remove(sched.id);
    expect(await maintenance.getById(sched.id)).toBeUndefined();
    const tomb = await driver.queryOne(
      'SELECT 1 AS ok FROM tombstones WHERE table_name = ? AND id = ?;',
      ['maintenance_schedules', sched.id],
    );
    expect(tomb).toBeDefined();
  });

  it('cascades schedules when the item is hard-deleted', async () => {
    const sched = await maintenance.create({
      itemId: printerId,
      name: 'Lube rails',
      basis: 'TIME',
      intervalDays: 90,
    });
    await items.hardDelete(printerId);
    expect(await maintenance.getById(sched.id)).toBeUndefined();
  });
});
