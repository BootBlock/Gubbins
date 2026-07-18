import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion, assertBaselineCurrent } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { BASELINE_REVISION, BASELINE_REVISION_KEY, type Migration } from './migration';
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
    expect(report.applied).toEqual(migrations.map((m) => m.version));
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
    const broken: Migration[] = [v1Initial, { version: 3, name: 'gap', statements: [{ sql: 'SELECT 1;' }] }];
    await expect(runMigrations(driver, broken)).rejects.toBeInstanceOf(DbError);
  });

  it('refuses to run when the database version is newer than the highest migration', async () => {
    // Simulate a stale pre-release baseline left at a high user_version (spec §2.3).
    await driver.execute(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 5};`);
    await expect(runMigrations(driver, migrations)).rejects.toMatchObject({
      name: 'DbError',
      code: 'SCHEMA_TOO_NEW',
    });
    // Guard is non-destructive: it neither writes nor rewinds the version.
    expect(await getUserVersion(driver)).toBe(TARGET_SCHEMA_VERSION + 5);
  });

  describe('baseline revision guard (issue #84)', () => {
    it('stamps the current baseline revision into app_meta', async () => {
      await runMigrations(driver, migrations);
      const row = await driver.queryOne<{ value: string }>('SELECT value FROM app_meta WHERE key = ?;', [
        BASELINE_REVISION_KEY,
      ]);
      expect(Number(row?.value)).toBe(BASELINE_REVISION);
    });

    it('accepts a database built by the current baseline', async () => {
      await runMigrations(driver, migrations);
      await expect(assertBaselineCurrent(driver)).resolves.toBeUndefined();
    });

    it('refuses a database built by an older revision of the baseline', async () => {
      await runMigrations(driver, migrations);
      await driver.execute('UPDATE app_meta SET value = ? WHERE key = ?;', [
        String(BASELINE_REVISION - 1),
        BASELINE_REVISION_KEY,
      ]);
      await expect(assertBaselineCurrent(driver)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('treats a malformed stamp as stale rather than letting NaN pass the check', async () => {
      await runMigrations(driver, migrations);
      await driver.execute('UPDATE app_meta SET value = ? WHERE key = ?;', [
        'nonsense',
        BASELINE_REVISION_KEY,
      ]);
      // Number('nonsense') is NaN, and NaN < n is false — it must not slip through.
      await expect(assertBaselineCurrent(driver)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('reports SCHEMA_STALE — not a raw SQL error — when app_meta is absent', async () => {
      await runMigrations(driver, migrations);
      await driver.execute('DROP TABLE app_meta;');
      await expect(assertBaselineCurrent(driver)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('refuses a database predating the stamp entirely — the issue #84 case', async () => {
      // A device that installed before location_tags was folded into the baseline: at the
      // target user_version, so runMigrations correctly applies nothing, but missing schema.
      await runMigrations(driver, migrations);
      await driver.execute('DELETE FROM app_meta WHERE key = ?;', [BASELINE_REVISION_KEY]);
      expect(await getUserVersion(driver)).toBe(TARGET_SCHEMA_VERSION);
      await expect(assertBaselineCurrent(driver)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });
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
    const survivors = await driver.query("SELECT name FROM sqlite_master WHERE name = 'good';");
    expect(survivors).toHaveLength(0);
  });
});
