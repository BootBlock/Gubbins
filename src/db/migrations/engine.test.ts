import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion, assertBaselineCurrent } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { BASELINE_REVISION_KEY, baselineFingerprint, type Migration } from './migration';
import { BASELINE_REVISION } from './v1-initial';
import { DbError } from '@/db/errors';
import type { IDatabaseDriver, SqlParams, SqlRow } from '@/db/rpc/driver';

/**
 * A healthy database whose *stamp read* fails a fixed number of times first — one queued error
 * per attempt, then SQLite answers normally. Models the issue #500 case: nothing is wrong with
 * the data, only with the round-trip that reads it.
 */
function withStampReadFailures(base: MemoryDriver, ...failures: readonly unknown[]): IDatabaseDriver {
  const pending = [...failures];
  return {
    ...base,
    async queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
      if (sql.includes('app_meta') && pending.length > 0) throw pending.shift();
      return base.queryOne<TRow>(sql, params);
    },
  };
}

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

  it('ratchets updated_at past a stamp that only just leads now (coarse-clock guarantee)', async () => {
    // A syncable table's auto-stamp trigger (updatedAtTrigger) must keep an edit provably newer
    // than the row it derived from even when the clock is too coarse to show it. A stamp a minute
    // ahead of now is within the honest-cause window (issue #393), so the +1 future-ratchet holds:
    // now < OLD, so MAX(now, OLD + 1) resolves to OLD + 1, not now.
    await runMigrations(driver, migrations);
    const old = Date.now() + 60_000; // 1 minute ahead — inside FUTURE_STAMP_REBASE_MS
    await driver.execute("INSERT INTO categories (id, name, updated_at) VALUES ('c', 'C', ?);", [old]);
    await driver.execute("UPDATE categories SET name = 'C2' WHERE id = 'c';");
    const row = await driver.queryOne<{ updated_at: number }>(
      "SELECT updated_at FROM categories WHERE id = 'c';",
    );
    expect(row?.updated_at).toBe(old + 1);
  });

  it('re-bases updated_at onto now when the stored stamp is implausibly far ahead (issue #393)', async () => {
    // A device whose clock was fast leaves rows stamped far in the future; once the clock is
    // corrected the one-directional +1 ratchet would keep them there forever, winning LWW against
    // every peer's genuinely-newer edit. Past FUTURE_STAMP_REBASE_MS the trigger re-bases the stamp
    // straight onto real time instead of inflating it by another millisecond.
    await runMigrations(driver, migrations);
    const inflated = Date.now() + 10 * 60_000; // 10 minutes ahead — beyond the threshold
    await driver.execute("INSERT INTO categories (id, name, updated_at) VALUES ('c', 'C', ?);", [inflated]);
    const before = Date.now();
    await driver.execute("UPDATE categories SET name = 'C2' WHERE id = 'c';");
    const after = Date.now();
    const row = await driver.queryOne<{ updated_at: number }>(
      "SELECT updated_at FROM categories WHERE id = 'c';",
    );
    // Brought back to the real clock, not left inflated (nor merely nudged by +1).
    expect(row?.updated_at).toBeLessThan(inflated - 5 * 60_000);
    expect(row?.updated_at).toBeGreaterThanOrEqual(before - 1_000);
    expect(row?.updated_at).toBeLessThanOrEqual(after + 1_000);
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
      expect(row?.value).toBe(BASELINE_REVISION);
    });

    it('accepts a database built by the current baseline', async () => {
      await runMigrations(driver, migrations);
      await expect(assertBaselineCurrent(driver, BASELINE_REVISION)).resolves.toBeUndefined();
    });

    it('refuses a database built from a different revision of the baseline', async () => {
      await runMigrations(driver, migrations);
      // Simulate a build whose baseline DDL differs from what wrote this database.
      await expect(assertBaselineCurrent(driver, 'deadbeef')).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('derives the fingerprint from the DDL, so editing the baseline changes it', () => {
      const base = [{ sql: 'CREATE TABLE a (id TEXT);' }];
      const edited = [{ sql: 'CREATE TABLE a (id TEXT);' }, { sql: 'CREATE TABLE b (id TEXT);' }];
      // The whole point: a developer folding a table into v1 cannot forget to bump it.
      expect(baselineFingerprint(base)).not.toBe(baselineFingerprint(edited));
      // Stable for identical input, so an unchanged baseline never forces a spurious reset.
      expect(baselineFingerprint(base)).toBe(baselineFingerprint([{ sql: 'CREATE TABLE a (id TEXT);' }]));
    });

    it('reports SCHEMA_STALE — not a raw SQL error — when app_meta is absent', async () => {
      await runMigrations(driver, migrations);
      await driver.execute('DROP TABLE app_meta;');
      await expect(assertBaselineCurrent(driver, BASELINE_REVISION)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('reports SCHEMA_STALE when the row is there but the column predates this build', async () => {
      // The other half of "predates the stamp": an `app_meta` too old to have the column being
      // read. SQLite says so in the same breath as a missing table, and it means the same thing.
      await runMigrations(driver, migrations);
      const flaky = withStampReadFailures(driver, new DbError('SQLITE_ERROR', 'no such column: value'));
      await expect(assertBaselineCurrent(flaky, BASELINE_REVISION)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SCHEMA_STALE',
      });
    });

    it('propagates a transient read failure instead of calling the schema stale (issue #500)', async () => {
      // The database is stamped and healthy — only the round-trip failed. Reporting SCHEMA_STALE
      // here would put a two-click purge in front of a user with nothing wrong with their data.
      await runMigrations(driver, migrations);
      const flaky = withStampReadFailures(
        driver,
        new DbError('WORKER_TIMEOUT', 'The database did not answer a "query" request within 30000ms.'),
      );
      await expect(assertBaselineCurrent(flaky, BASELINE_REVISION)).rejects.toMatchObject({
        name: 'DbError',
        code: 'WORKER_TIMEOUT',
      });
    });

    it('does not read a worker failure as an unstamped database, whatever its message says', async () => {
      // A dead worker can quote anything — including SQLite text it relayed from somewhere else.
      // The code, not just the wording, is what rules a missing table in.
      await runMigrations(driver, migrations);
      const flaky = withStampReadFailures(
        driver,
        new DbError('WORKER_UNAVAILABLE', 'Database worker error: no such table: app_meta'),
      );
      await expect(assertBaselineCurrent(flaky, BASELINE_REVISION)).rejects.toMatchObject({
        name: 'DbError',
        code: 'WORKER_UNAVAILABLE',
      });
    });

    it('retries lock contention rather than concluding anything from it', async () => {
      await runMigrations(driver, migrations);
      const flaky = withStampReadFailures(driver, new DbError('SQLITE_BUSY', 'database is locked'));
      await expect(assertBaselineCurrent(flaky, BASELINE_REVISION)).resolves.toBeUndefined();
    });

    it('reports lock contention that outlasts the retry as itself, not as a stale schema', async () => {
      await runMigrations(driver, migrations);
      const flaky = withStampReadFailures(
        driver,
        new DbError('SQLITE_BUSY', 'database is locked'),
        new DbError('SQLITE_BUSY', 'database is locked'),
      );
      await expect(assertBaselineCurrent(flaky, BASELINE_REVISION)).rejects.toMatchObject({
        name: 'DbError',
        code: 'SQLITE_BUSY',
      });
    });

    it('refuses a database predating the stamp entirely — the issue #84 case', async () => {
      // A device that installed before location_tags was folded into the baseline: at the
      // target user_version, so runMigrations correctly applies nothing, but missing schema.
      await runMigrations(driver, migrations);
      await driver.execute('DELETE FROM app_meta WHERE key = ?;', [BASELINE_REVISION_KEY]);
      expect(await getUserVersion(driver)).toBe(TARGET_SCHEMA_VERSION);
      await expect(assertBaselineCurrent(driver, BASELINE_REVISION)).rejects.toMatchObject({
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
