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

describe('MaintenanceRepository — checkout-hours telemetry (§4.3, Phase 22)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let maintenance: MaintenanceRepository;
  let toolId: string;
  const HOUR = 3_600_000;
  const NOW = 1_700_000_000_000;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    toolId = (await items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' })).id;
    await driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', ['c1', 'Alex']);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Insert a loan window directly so the derivation maths is deterministic. */
  async function loan(checkedOutAt: number, returnedAt: number | null): Promise<void> {
    await driver.execute(
      `INSERT INTO checkouts (id, item_id, contact_id, quantity, checked_out_at, returned_at)
       VALUES (?, ?, 'c1', 1, ?, ?);`,
      [crypto.randomUUID(), toolId, checkedOutAt, returnedAt],
    );
  }

  it('defaults the usage unit to hours and rejects manual logging in accrue mode', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
    });
    expect(sched.accrueCheckoutHours).toBe(true);
    expect(sched.usageUnit).toBe('hours');
    await expect(maintenance.addUsage(sched.id, 5)).rejects.toBeInstanceOf(DbError);
  });

  it('derives auto usage-hours from loans begun since the service anchor', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
    });
    // Anchor at creation; backdate it so the loans below fall after it.
    await driver.execute('UPDATE maintenance_schedules SET created_at = ? WHERE id = ?;', [
      NOW - 100 * HOUR,
      sched.id,
    ]);
    await loan(NOW - 100 * HOUR - 5 * HOUR, NOW - 100 * HOUR - 1 * HOUR); // before anchor → ignored
    await loan(NOW - 40 * HOUR, NOW - 30 * HOUR); // 10h
    await loan(NOW - 8 * HOUR, null); // still out → 8h at NOW

    const [read] = await maintenance.listForItem(toolId, NOW);
    expect(read.autoUsageHours).toBe(18);
    expect(read.usageSinceService).toBe(0); // manual counter untouched
    // Not yet due (18 < 50); becomes due once the derived hours reach the interval.
    expect(await maintenance.countDue(NOW)).toBe(0);
  });

  it('reports due via derived hours and resets to post-service loans on logPerformed', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
    });
    await driver.execute('UPDATE maintenance_schedules SET created_at = ? WHERE id = ?;', [
      NOW - 200 * HOUR,
      sched.id,
    ]);
    await loan(NOW - 100 * HOUR, NOW - 40 * HOUR); // 60h ≥ 50 → due

    expect(await maintenance.countDue(NOW)).toBe(1);
    const due = await maintenance.listDue(NOW);
    expect(due.rows[0].autoUsageHours).toBe(60);

    // Service it: the anchor advances to NOW, so the old loan no longer counts.
    await maintenance.logPerformed(sched.id, NOW, 'Recalibrated.');
    expect(await maintenance.countDue(NOW)).toBe(0);
    const [reset] = await maintenance.listForItem(toolId, NOW);
    expect(reset.autoUsageHours).toBe(0);

    // A fresh loan after the service accrues anew.
    await loan(NOW + 1 * HOUR, NOW + 11 * HOUR); // 10h
    const [again] = await maintenance.listForItem(toolId, NOW + 12 * HOUR);
    expect(again.autoUsageHours).toBe(10);
  });

  it('a manual USAGE schedule is unaffected by loans (no accrual)', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Manual count',
      basis: 'USAGE',
      intervalUsage: 5,
      usageUnit: 'cycles',
    });
    await loan(NOW - 100 * HOUR, NOW); // a long loan, but this schedule does not accrue
    const [read] = await maintenance.listForItem(toolId, NOW);
    expect(read.accrueCheckoutHours).toBe(false);
    expect(read.autoUsageHours).toBe(0);
    expect(await maintenance.countDue(NOW)).toBe(0);
    await maintenance.addUsage(sched.id, 5); // manual logging still works
    expect(await maintenance.countDue(NOW)).toBe(1);
  });
});

describe('MaintenanceRepository — per-location scheduling (§4.3, Phase 30)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let maintenance: MaintenanceRepository;
  let toolId: string;
  const HOUR = 3_600_000;
  const NOW = 1_700_000_000_000;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    toolId = (await items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' })).id;
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?), (?, ?);', [
      'bench', 'Workshop bench', 'store', 'Storeroom',
    ]);
    await driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', ['c1', 'Alex']);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Insert a loan window with an explicit lend-from location (Phase 26). */
  async function loanFrom(
    sourceLocationId: string | null,
    checkedOutAt: number,
    returnedAt: number | null,
  ): Promise<void> {
    await driver.execute(
      `INSERT INTO checkouts (id, item_id, contact_id, quantity, checked_out_at, returned_at, source_location_id)
       VALUES (?, ?, 'c1', 1, ?, ?, ?);`,
      [crypto.randomUUID(), toolId, checkedOutAt, returnedAt, sourceLocationId],
    );
  }

  it('persists a scope location and joins its name on read', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Bench calibrate',
      basis: 'TIME',
      intervalDays: 30,
      locationId: 'bench',
    });
    expect(sched.locationId).toBe('bench');
    expect(sched.locationName).toBe('Workshop bench');

    // An item-level schedule carries no scope.
    const itemLevel = await maintenance.create({
      itemId: toolId,
      name: 'Whole-tool service',
      basis: 'TIME',
      intervalDays: 90,
    });
    expect(itemLevel.locationId).toBeNull();
    expect(itemLevel.locationName).toBeNull();
  });

  it('rejects a scope location that does not exist (FK)', async () => {
    await expect(
      maintenance.create({
        itemId: toolId,
        name: 'X',
        basis: 'TIME',
        intervalDays: 30,
        locationId: 'ghost',
      }),
    ).rejects.toThrow();
  });

  it('accrues only loans drawn from the scoped placement (else every loan)', async () => {
    const benchSched = await maintenance.create({
      itemId: toolId,
      name: 'Bench recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
      locationId: 'bench',
    });
    const itemSched = await maintenance.create({
      itemId: toolId,
      name: 'Whole-tool recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
    });
    // Anchor both at creation, backdated so the loans fall after it.
    await driver.execute('UPDATE maintenance_schedules SET created_at = ? WHERE item_id = ?;', [
      NOW - 100 * HOUR,
      toolId,
    ]);

    await loanFrom('bench', NOW - 40 * HOUR, NOW - 30 * HOUR); // 10h at the bench
    await loanFrom('store', NOW - 20 * HOUR, NOW - 15 * HOUR); // 5h at the store
    await loanFrom(null, NOW - 8 * HOUR, NOW - 6 * HOUR); // 2h, source unknown

    const schedules = await maintenance.listForItem(toolId, NOW);
    const bench = schedules.find((s) => s.id === benchSched.id)!;
    const whole = schedules.find((s) => s.id === itemSched.id)!;
    expect(bench.autoUsageHours).toBe(10); // only the bench loan
    expect(whole.autoUsageHours).toBe(17); // every loan (10 + 5 + 2)
  });

  it('reports a location-scoped schedule due via its placement-only hours', async () => {
    const sched = await maintenance.create({
      itemId: toolId,
      name: 'Bench recalibrate',
      basis: 'USAGE',
      intervalUsage: 50,
      accrueCheckoutHours: true,
      locationId: 'bench',
    });
    await driver.execute('UPDATE maintenance_schedules SET created_at = ? WHERE id = ?;', [
      NOW - 200 * HOUR,
      sched.id,
    ]);
    // A long loan from the *store* must not make the bench schedule due.
    await loanFrom('store', NOW - 100 * HOUR, NOW - 30 * HOUR); // 70h elsewhere
    expect(await maintenance.countDue(NOW)).toBe(0);

    // A 60h bench loan crosses the 50h interval.
    await loanFrom('bench', NOW - 80 * HOUR, NOW - 20 * HOUR); // 60h at the bench
    expect(await maintenance.countDue(NOW)).toBe(1);
    const due = await maintenance.listDue(NOW);
    expect(due.rows[0].locationName).toBe('Workshop bench');
    expect(due.rows[0].autoUsageHours).toBe(60);
  });
});
