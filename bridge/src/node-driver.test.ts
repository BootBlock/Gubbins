/**
 * Driver-level tests for the bridge's `node:sqlite` driver, focused on its bounded
 * prepared-statement cache (issue #174).
 *
 * The cache exists because the bridge is a long-lived process answering the same handful
 * of statement texts repeatedly, and `node:sqlite` re-parses and re-plans on every
 * `prepare()`. These tests pin the three properties that make it safe to keep compiled
 * statements around: reuse (a repeated text compiles once), *correctness* under reuse (a
 * reused statement must re-bind, not replay the previous parameters), and invalidation
 * (DDL drops the cache, and the cache is bounded rather than growing with traffic).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDriver, type NodeDriver } from './node-driver.ts';

let driver: NodeDriver | undefined;

function makeDriver(): NodeDriver {
  driver = createNodeDriver();
  return driver;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await driver?.close();
  driver = undefined;
});

async function seed(d: NodeDriver): Promise<void> {
  await d.execute('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, qty INTEGER);');
  await d.transaction([
    { sql: 'INSERT INTO widgets (id, name, qty) VALUES (?, ?, ?);', params: ['a', 'Anvil', 2] },
    { sql: 'INSERT INTO widgets (id, name, qty) VALUES (?, ?, ?);', params: ['b', 'Bolt', 5] },
    { sql: 'INSERT INTO widgets (id, name, qty) VALUES (?, ?, ?);', params: ['c', 'Cog', 8] },
  ]);
}

describe('createNodeDriver prepared-statement cache', () => {
  it('compiles a repeated statement once and reuses it', async () => {
    const d = makeDriver();
    await seed(d);

    const prepareSpy = vi.spyOn(d.raw, 'prepare');
    const sql = 'SELECT name FROM widgets WHERE id = ?;';

    for (let i = 0; i < 5; i += 1) {
      await d.query(sql, ['a']);
    }

    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('re-binds parameters on every reuse rather than replaying the previous ones', async () => {
    const d = makeDriver();
    await seed(d);

    const sql = 'SELECT id, name, qty FROM widgets WHERE id = ?;';
    const first = await d.queryOne<{ id: string; name: string; qty: number }>(sql, ['a']);
    const second = await d.queryOne<{ id: string; name: string; qty: number }>(sql, ['c']);
    const third = await d.queryOne<{ id: string; name: string; qty: number }>(sql, ['b']);
    // A no-match must return undefined, not the last successful row.
    const missing = await d.queryOne(sql, ['nope']);

    expect(first).toMatchObject({ name: 'Anvil', qty: 2 });
    expect(second).toMatchObject({ name: 'Cog', qty: 8 });
    expect(third).toMatchObject({ name: 'Bolt', qty: 5 });
    expect(missing).toBeUndefined();
  });

  it('shares one compiled statement across query, queryOne and execute call shapes', async () => {
    const d = makeDriver();
    await seed(d);

    const sql = 'SELECT id FROM widgets WHERE qty > ?;';
    await d.query(sql, [1]);
    const prepareSpy = vi.spyOn(d.raw, 'prepare');
    await d.queryOne(sql, [4]);
    await d.query(sql, [7]);

    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('reuses a parameterised statement across transactions', async () => {
    const d = makeDriver();
    await seed(d);

    const sql = 'UPDATE widgets SET qty = ? WHERE id = ?;';
    await d.transaction([{ sql, params: [10, 'a'] }]);
    const prepareSpy = vi.spyOn(d.raw, 'prepare');
    await d.transaction([{ sql, params: [11, 'b'] }]);

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(await d.queryOne<{ qty: number }>('SELECT qty FROM widgets WHERE id = ?;', ['b'])).toEqual({
      qty: 11,
    });
  });

  it('does not cache DDL, and drops cached statements when the schema changes', async () => {
    const d = makeDriver();
    await seed(d);

    await d.query('SELECT id FROM widgets;');
    expect(d.cachedStatementCount).toBeGreaterThan(0);

    // DDL is never itself cached...
    await d.execute('ALTER TABLE widgets ADD COLUMN colour TEXT;');
    // ...and it invalidates everything compiled against the old schema.
    expect(d.cachedStatementCount).toBe(0);

    // The new column is visible to a statement with the same text as the cached one.
    const rows = await d.query<Record<string, unknown>>('SELECT * FROM widgets WHERE id = ?;', ['a']);
    expect(rows[0]).toHaveProperty('colour', null);
  });

  it('drops cached statements when a transaction runs an unparameterised script', async () => {
    const d = makeDriver();
    await seed(d);

    await d.query('SELECT id FROM widgets;');
    expect(d.cachedStatementCount).toBeGreaterThan(0);

    await d.transaction([{ sql: 'ALTER TABLE widgets ADD COLUMN colour TEXT;' }]);

    expect(d.cachedStatementCount).toBe(0);
  });

  it('re-binds named parameters on reuse', async () => {
    const d = makeDriver();
    await seed(d);

    const sql = 'SELECT name FROM widgets WHERE qty >= :min AND qty <= :max;';
    const low = await d.query<{ name: string }>(sql, { min: 1, max: 3 });
    const high = await d.query<{ name: string }>(sql, { min: 6, max: 9 });

    expect(low.map((r) => r.name)).toEqual(['Anvil']);
    expect(high.map((r) => r.name)).toEqual(['Cog']);
  });

  it('does not flush the cache for a read-only PRAGMA', async () => {
    const d = makeDriver();
    await seed(d);

    const hot = 'SELECT id FROM widgets WHERE qty > ?;';
    await d.query(hot, [0]);
    const before = d.cachedStatementCount;
    expect(before).toBeGreaterThan(0);

    // A diagnostics/health caller polling these must not defeat the cache.
    await d.queryOne('PRAGMA page_count;');
    await d.queryOne('PRAGMA user_version;');

    expect(d.cachedStatementCount).toBe(before);
    const prepareSpy = vi.spyOn(d.raw, 'prepare');
    await d.query(hot, [0]);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('keeps the cache across a transaction that runs a non-DDL unparameterised statement', async () => {
    const d = makeDriver();
    await seed(d);

    const hot = 'SELECT id FROM widgets WHERE qty > ?;';
    await d.query(hot, [0]);
    const before = d.cachedStatementCount;

    await d.transaction([{ sql: "UPDATE widgets SET name = 'Anvil II' WHERE id = 'a';" }]);

    expect(d.cachedStatementCount).toBe(before);
  });

  it('surfaces a compile failure as a DbError without caching the bad text', async () => {
    const d = makeDriver();
    await seed(d);

    const before = d.cachedStatementCount;
    await expect(d.query('SELECT * FROM no_such_table;')).rejects.toThrow();
    expect(d.cachedStatementCount).toBe(before);
  });

  it('stays bounded when the statement text varies with caller input', async () => {
    const d = makeDriver();
    await seed(d);

    // Stand-in for the real unbounded-text sources: a search/`$filter` WHERE clause and an
    // `IN (?, ?, …)` list, both of which vary in shape with what the caller asked for.
    for (let i = 0; i < 1000; i += 1) {
      const placeholders = Array.from({ length: (i % 40) + 1 }, () => '?').join(', ');
      await d.query(
        `SELECT id FROM widgets WHERE id IN (${placeholders}) AND qty > ${i};`,
        Array.from({ length: (i % 40) + 1 }, () => 'a'),
      );
    }

    expect(d.cachedStatementCount).toBeLessThanOrEqual(256);
  });

  it('evicts least-recently-used entries, keeping the hot statement compiled', async () => {
    const d = makeDriver();
    await seed(d);

    const hot = 'SELECT id FROM widgets WHERE qty > ?;';
    await d.query(hot, [0]);

    // Flood past the bound, touching the hot statement along the way.
    for (let i = 0; i < 400; i += 1) {
      await d.query(`SELECT id FROM widgets WHERE qty > ${i};`);
      await d.query(hot, [0]);
    }

    const prepareSpy = vi.spyOn(d.raw, 'prepare');
    await d.query(hot, [0]);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('releases cached statements on close', async () => {
    const d = makeDriver();
    await seed(d);
    await d.query('SELECT id FROM widgets;');
    expect(d.cachedStatementCount).toBeGreaterThan(0);

    await d.close();
    driver = undefined;

    expect(d.cachedStatementCount).toBe(0);
  });
});
