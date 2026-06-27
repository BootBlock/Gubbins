import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import type { Migration } from './migration';
import { DbError } from '@/db/errors';

describe('migration engine', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reports user_version 0 on a fresh database', async () => {
    expect(await getUserVersion(driver)).toBe(0);
  });

  it('applies the baseline migration and bumps user_version to the target', async () => {
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(0);
    expect(report.to).toBe(TARGET_SCHEMA_VERSION);
    expect(report.applied).toEqual([1]);
    expect(await getUserVersion(driver)).toBe(TARGET_SCHEMA_VERSION);
  });

  it('creates the app_meta table', async () => {
    await runMigrations(driver, migrations);
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta';",
    );
    expect(tables).toHaveLength(1);
  });

  it('is idempotent — a second run applies nothing', async () => {
    await runMigrations(driver, migrations);
    const second = await runMigrations(driver, migrations);
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(TARGET_SCHEMA_VERSION);
    expect(await getUserVersion(driver)).toBe(TARGET_SCHEMA_VERSION);
  });

  it('defaults updated_at to a millisecond epoch on INSERT', async () => {
    await runMigrations(driver, migrations);
    const before = Date.now();
    await driver.execute("INSERT INTO app_meta (key, value) VALUES ('boot', 'ok');");
    const row = await driver.queryOne<{ updated_at: number }>(
      "SELECT updated_at FROM app_meta WHERE key = 'boot';",
    );
    // Proves milliseconds (not seconds): a ms epoch is ~1.7e12 in 2026.
    expect(row?.updated_at).toBeGreaterThan(1_700_000_000_000);
    expect(row?.updated_at).toBeGreaterThanOrEqual(before - 60_000);
  });

  it('auto-stamps updated_at on UPDATE when the caller leaves it unchanged (LWW trigger)', async () => {
    await runMigrations(driver, migrations);
    await driver.execute("INSERT INTO app_meta (key, value, updated_at) VALUES ('k', 'v1', 1000);");
    await driver.execute("UPDATE app_meta SET value = 'v2' WHERE key = 'k';");
    const row = await driver.queryOne<{ value: string; updated_at: number }>(
      "SELECT value, updated_at FROM app_meta WHERE key = 'k';",
    );
    expect(row?.value).toBe('v2');
    expect(row?.updated_at).toBeGreaterThan(1000);
  });

  it('preserves an explicitly supplied updated_at on UPDATE (sync LWW pass-through)', async () => {
    await runMigrations(driver, migrations);
    await driver.execute("INSERT INTO app_meta (key, value, updated_at) VALUES ('k', 'v1', 1000);");
    await driver.execute("UPDATE app_meta SET value = 'v2', updated_at = 5000 WHERE key = 'k';");
    const row = await driver.queryOne<{ updated_at: number }>(
      "SELECT updated_at FROM app_meta WHERE key = 'k';",
    );
    expect(row?.updated_at).toBe(5000);
  });

  it('rejects a non-contiguous migration version sequence', async () => {
    const broken: Migration[] = [
      v1Initial,
      { version: 3, name: 'gap', statements: [{ sql: 'SELECT 1;' }] },
    ];
    await expect(runMigrations(driver, broken)).rejects.toBeInstanceOf(DbError);
  });

  it('rolls back atomically and halts when a migration statement fails', async () => {
    const broken: Migration[] = [
      {
        version: 1,
        name: 'bad',
        statements: [
          { sql: 'CREATE TABLE good (id INTEGER);' },
          { sql: 'CREATE TABLE bad (;' }, // deliberate syntax error
        ],
      },
    ];
    await expect(runMigrations(driver, broken)).rejects.toBeInstanceOf(DbError);
    // Atomic: neither the 'good' table nor the version bump may survive.
    expect(await getUserVersion(driver)).toBe(0);
    const survivors = await driver.query(
      "SELECT name FROM sqlite_master WHERE name = 'good';",
    );
    expect(survivors).toHaveLength(0);
  });
});
