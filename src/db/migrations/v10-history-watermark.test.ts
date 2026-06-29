import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v10 history-prune-watermark migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations.filter((m) => m.version <= 10));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 10', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(10);
  });

  it('adds history_pruned_before to the seeded sync_meta row defaulting to 0', async () => {
    const row = await driver.queryOne<{ history_pruned_before: number }>(
      'SELECT history_pruned_before FROM sync_meta WHERE id = 1;',
    );
    expect(Number(row?.history_pruned_before)).toBe(0);
  });

  it('accepts a UNIX-ms prune cutoff', async () => {
    await driver.execute('UPDATE sync_meta SET history_pruned_before = ? WHERE id = 1;', [
      1_900_000_000_000,
    ]);
    const row = await driver.queryOne<{ history_pruned_before: number }>(
      'SELECT history_pruned_before FROM sync_meta WHERE id = 1;',
    );
    expect(Number(row?.history_pruned_before)).toBe(1_900_000_000_000);
  });
});
