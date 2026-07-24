import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_EXCLUDED_COLUMNS } from '@/db/repositories';
import { NON_LWW_COLUMNS } from './conflict-detect';
import { TABLE_FILTER } from './snapshot';

/**
 * Drift guard (#246) for the sync side-tables typed `Partial<Record<SyncTable, …>>`. Like
 * {@link FK_REFS} (guarded in `fk-refs.test.ts`), these three maps disable the exhaustiveness
 * check by construction — most tables need no entry — so a column rename cannot make the compiler
 * complain that an entry now names a column that no longer exists. The entry just goes silently
 * stale, and the behaviour it encodes quietly stops working:
 *
 *  - {@link NON_LWW_COLUMNS} — a stale name means a column the CRDT owns starts being resolved by
 *    Last-Write-Wins again, clobbering the merged value it was meant to protect;
 *  - {@link SYNC_EXCLUDED_COLUMNS} — a stale name means per-device OPFS state stops being stripped
 *    and starts leaking into every peer's snapshot;
 *  - {@link TABLE_FILTER} — a stale column makes the snapshot read itself throw `no such column`.
 *
 * So read the real, built schema and assert every column each map names exists, and that every
 * filter fragment executes against its table.
 */
describe('sync Partial<Record<SyncTable>> maps reference only real schema columns (#246)', () => {
  let driver: MemoryDriver;
  /** table → its actual column names, from the built schema. */
  let columnsByTable: Map<string, Set<string>>;

  beforeAll(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    columnsByTable = new Map();
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table';",
    );
    for (const { name } of tables) {
      const cols = await driver.query<{ name: string }>(`PRAGMA table_info(${name});`);
      columnsByTable.set(name, new Set(cols.map((c) => c.name)));
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('enumerated the schema (guards against a vacuously-passing suite)', () => {
    expect(columnsByTable.get('items')?.has('current_net_value')).toBe(true);
    expect(columnsByTable.get('item_images')?.has('full_res_downgraded_at')).toBe(true);
  });

  it('NON_LWW_COLUMNS names only columns that exist', () => {
    // Non-empty, or the assertions below would be vacuous.
    expect(Object.keys(NON_LWW_COLUMNS).length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [table, cols] of Object.entries(NON_LWW_COLUMNS)) {
      const schemaCols = columnsByTable.get(table);
      for (const col of cols ?? []) {
        if (!schemaCols?.has(col)) missing.push(`${table}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('SYNC_EXCLUDED_COLUMNS names only columns that exist', () => {
    expect(Object.keys(SYNC_EXCLUDED_COLUMNS).length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [table, cols] of Object.entries(SYNC_EXCLUDED_COLUMNS)) {
      const schemaCols = columnsByTable.get(table);
      for (const col of cols ?? []) {
        if (!schemaCols?.has(col)) missing.push(`${table}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('TABLE_FILTER fragments execute against their table (every referenced column exists)', async () => {
    expect(Object.keys(TABLE_FILTER).length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const [table, filter] of Object.entries(TABLE_FILTER)) {
      if (!filter) continue;
      // The fragment is a bare WHERE condition; running it as `SELECT COUNT(*) … WHERE <filter>`
      // throws `no such column` if the filter references a column the schema no longer has.
      try {
        await driver.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${filter};`);
      } catch (err) {
        broken.push(`${table}: ${filter} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every table these maps key on is a real schema table', () => {
    const keyed = new Set<string>([
      ...Object.keys(NON_LWW_COLUMNS),
      ...Object.keys(SYNC_EXCLUDED_COLUMNS),
      ...Object.keys(TABLE_FILTER),
    ]);
    const unknown = [...keyed].filter((t) => !columnsByTable.has(t));
    expect(unknown).toEqual([]);
  });
});
