/**
 * Best-effort snapshot reads (issue #197).
 *
 * The boot-failure screen has to build a backup out of a database this build cannot open —
 * a table it knows about may simply not exist there. These cover the `skipUnreadable` mode
 * that makes that possible, and that the ordinary path is left strict.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildLocalSnapshot } from './snapshot';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { IDatabaseDriver, SqlParams, SqlRow } from '@/db/rpc/driver';

/** The table a `SELECT … FROM <table>` reads, for the fake driver's routing. */
function tableOf(sql: string): string {
  return /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1] ?? '';
}

/**
 * A driver that answers only for `readable` and raises SQLite's own "no such table" for
 * everything else — the shape of a database built from a different baseline.
 */
function fakeDriver(readable: Record<string, SqlRow[]>): IDatabaseDriver {
  const query = async (sql: string, params?: SqlParams): Promise<SqlRow[]> => {
    const table = tableOf(sql);
    const rows = readable[table];
    if (!rows) throw new Error(`no such table: ${table}`);
    // Honour the paging window so `buildLocalSnapshot`'s loop terminates.
    const [limit, offset] = (params as number[] | undefined) ?? [];
    if (typeof limit === 'number' && typeof offset === 'number') return rows.slice(offset, offset + limit);
    return rows;
  };
  return {
    query: query as IDatabaseDriver['query'],
    queryOne: (async (sql, params) => (await query(sql, params))[0]) as IDatabaseDriver['queryOne'],
    execute: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  } as unknown as IDatabaseDriver;
}

describe('buildLocalSnapshot — skipUnreadable (issue #197)', () => {
  const items: SqlRow[] = [{ id: 'i1', name: 'Widget', is_active: 1 }];

  it('fails outright by default, so sync and an ordinary backup never ship a partial picture', async () => {
    await expect(buildLocalSnapshot(fakeDriver({ items }))).rejects.toThrow(/no such table/);
  });

  it('takes what it can read and reports the rest instead of failing', async () => {
    const skipped: string[] = [];
    const snapshot = await buildLocalSnapshot(fakeDriver({ items }), 1, {
      skipUnreadable: true,
      onSkipped: (part) => skipped.push(part),
    });

    expect(snapshot.tables.items).toEqual(items);
    expect(snapshot.tables.categories).toEqual([]);
    expect(snapshot.tombstones).toEqual([]);
    expect(snapshot.itemHistory).toEqual([]);
    // Every unreadable part is named, so the user can be told what did not make it.
    expect(skipped).toContain('categories');
    expect(skipped).toContain('tombstones');
  });

  it('still excludes the protected rows when the filter column is missing', async () => {
    // `locations` here has no `is_system`, so the filtered read fails and the fallback runs.
    const locations: SqlRow[] = [
      { id: UNASSIGNED_LOCATION_ID, name: 'Unassigned' },
      { id: 'l1', name: 'Shelf' },
    ];
    const driver = fakeDriver({ locations });
    const original = driver.query.bind(driver);
    // Reject only the filtered form, exactly as SQLite would for an absent column.
    driver.query = (async (sql: string, params?: SqlParams) => {
      if (sql.includes('is_system')) throw new Error('no such column: is_system');
      return original(sql, params);
    }) as IDatabaseDriver['query'];

    const snapshot = await buildLocalSnapshot(driver, 1, { skipUnreadable: true });

    // Recovered the real rows without smuggling the system-locked one into the backup — a
    // restore would trip its protect trigger and abort the whole transaction.
    expect(snapshot.tables.locations).toEqual([{ id: 'l1', name: 'Shelf' }]);
  });
});
