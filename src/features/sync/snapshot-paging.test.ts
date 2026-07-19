/**
 * Issue #204: a snapshot read must not lose rows to a concurrent write.
 *
 * `buildLocalSnapshot` issues dozens of paged reads and the driver has no row-returning
 * transaction, so it cannot hold one isolated view of the database across them. A write
 * landing between two pages is therefore expected — the Node bridge is a peer writing to the
 * same dataset, and in-app background work is not excluded either. What is *not* acceptable is
 * that such a write silently drops an unrelated row from the backup, which is exactly what
 * `LIMIT/OFFSET` paging did: a delete shifts every later row one position earlier, so the row
 * straddling the page boundary is never read and nothing reports its absence.
 *
 * These run over `node:sqlite` with the real schema, because the bug lives in how the SQL pages
 * rather than in any of the logic above it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { buildLocalSnapshot } from './snapshot';
import type { IDatabaseDriver } from '@/db/rpc/driver';

/** The snapshot pages at 100; seed enough that `items` genuinely spans more than one page. */
const SEEDED = 150;

/** `i-000` … so ids sort in the order they were inserted. */
const itemId = (n: number) => `i-${String(n).padStart(3, '0')}`;

/**
 * A driver that runs `intrude` once, immediately after the first page of `items` is read —
 * standing in for the peer write that lands mid-snapshot.
 */
function withMidReadWrite(driver: MemoryDriver, intrude: (d: MemoryDriver) => Promise<void>) {
  let fired = false;
  const query: IDatabaseDriver['query'] = async (sql, params) => {
    const rows = await driver.query(sql, params);
    if (!fired && sql.includes('FROM items ')) {
      fired = true;
      await intrude(driver);
    }
    return rows as never;
  };
  return new Proxy(driver, {
    get: (target, prop, receiver) =>
      prop === 'query' ? query : Reflect.get(target, prop, receiver as unknown as object),
  }) as unknown as IDatabaseDriver;
}

describe('buildLocalSnapshot paging (issue #204)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    for (let n = 0; n < SEEDED; n += 1) {
      await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
        itemId(n),
        `Item ${n}`,
        UNASSIGNED_LOCATION_ID,
        1,
      ]);
    }
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reads every row of a multi-page table', async () => {
    const snapshot = await buildLocalSnapshot(driver, 1);
    expect(snapshot.tables.items).toHaveLength(SEEDED);
  });

  it('keeps every surviving row when a row is deleted mid-read', async () => {
    // Deleting from the *first* page is the case OFFSET paging could not survive: every later
    // row shifts down one, so the row on the page boundary is stepped straight over.
    const snapshot = await buildLocalSnapshot(
      withMidReadWrite(driver, (d) => d.execute('DELETE FROM items WHERE id = ?;', [itemId(0)])),
      1,
    );

    const ids = (snapshot.tables.items ?? []).map((row) => String(row.id));
    // The deleted row may or may not be present — it was read before it was deleted. Every
    // *other* row must be, and none may appear twice.
    expect(new Set(ids).size).toBe(ids.length);
    const survivors = Array.from({ length: SEEDED - 1 }, (_, n) => itemId(n + 1));
    expect(survivors.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('keeps every row when one is inserted behind the read cursor mid-read', async () => {
    const snapshot = await buildLocalSnapshot(
      withMidReadWrite(driver, (d) =>
        d.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
          'i-000-a',
          'Squeezed in',
          UNASSIGNED_LOCATION_ID,
          1,
        ]),
      ),
      1,
    );

    const ids = (snapshot.tables.items ?? []).map((row) => String(row.id));
    expect(new Set(ids).size).toBe(ids.length);
    const seeded = Array.from({ length: SEEDED }, (_, n) => itemId(n));
    expect(seeded.filter((id) => !ids.includes(id))).toEqual([]);
  });
});
