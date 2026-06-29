import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v11 maintenance-usage-telemetry migration', () => {
  let driver: MemoryDriver;

  async function makeSchedule(id: string): Promise<void> {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      `item-${id}`,
      `Item ${id}`,
      UNASSIGNED_LOCATION_ID,
    ]);
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_usage, usage_unit)
       VALUES (?, ?, 'Nozzle', 'USAGE', 100, 'hours');`,
      [id, `item-${id}`],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Stop at v11 so this test asserts the v11 end-state regardless of later migrations.
    await runMigrations(driver, migrations.filter((m) => m.version <= 11));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 11', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(11);
  });

  it('adds accrue_checkout_hours defaulting to 0 (opt-out)', async () => {
    await makeSchedule('s1');
    const row = await driver.queryOne<{ accrue_checkout_hours: number }>(
      'SELECT accrue_checkout_hours FROM maintenance_schedules WHERE id = ?;',
      ['s1'],
    );
    expect(row?.accrue_checkout_hours).toBe(0);
  });

  it('records an opt-in without disturbing the existing usage counter', async () => {
    await makeSchedule('s1');
    await driver.execute(
      'UPDATE maintenance_schedules SET accrue_checkout_hours = 1 WHERE id = ?;',
      ['s1'],
    );
    const row = await driver.queryOne<{
      accrue_checkout_hours: number;
      usage_since_service: number;
    }>(
      'SELECT accrue_checkout_hours, usage_since_service FROM maintenance_schedules WHERE id = ?;',
      ['s1'],
    );
    expect(row?.accrue_checkout_hours).toBe(1);
    expect(row?.usage_since_service).toBe(0);
  });
});
