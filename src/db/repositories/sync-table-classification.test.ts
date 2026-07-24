/**
 * Drift guard (issue #245): every real table in the built v1 schema must be *consciously*
 * classified as synced or explicitly not-synced.
 *
 * The sync-set is a hand-maintained dictionary ({@link SYNC_TABLES} plus the bespoke sections
 * {@link ITEM_TAGS_TABLE} / {@link LOCATION_TAGS_TABLE} / {@link ITEM_REGIONS_TABLE} /
 * {@link ITEM_HISTORY_TABLE}). A table left out of all of them defaults *silently* to
 * unsynced — exactly how `kit_components` was lost on restore for a whole release (issue #151)
 * without anything failing. This test removes the silent default: it enumerates the schema
 * straight from `sqlite_master` and asserts each table lands in exactly one bucket, where the
 * only way to be "not synced" is to be named in the explicit {@link NOT_SYNCED} allow-list.
 *
 * The upshot: add a table to the migration and this test fails until you decide, in code, which
 * bucket it belongs in — a synced table joins {@link SYNC_TABLES}, a device-local/derived one
 * joins {@link NOT_SYNCED}.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  SYNC_TABLES,
  ITEM_TAGS_TABLE,
  LOCATION_TAGS_TABLE,
  ITEM_REGIONS_TABLE,
  ITEM_HISTORY_TABLE,
  NOT_SYNCED,
} from './tombstone';

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/**
 * The real, developer-declared tables that must be classified. This deliberately skips:
 *  - `sqlite_*` internal tables (autoindex, sequence, …) — engine bookkeeping, never in a migration.
 *  - the FTS5 virtual table `items_fts` and its shadow tables (`items_fts_data`, `_idx`, …). A
 *    virtual table is an engine-managed index rebuilt from `items`, never independently syncable
 *    data. Shadow tables are derived from the virtual table's own name (`<vtab>_*`), so this stays
 *    correct if another FTS index is ever added.
 *  - views (`type = 'view'`) — projections over base tables, they hold no rows of their own.
 */
function classifiableTables(objects: readonly SchemaObject[]): string[] {
  const virtualTables = objects
    .filter((o) => o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql ?? ''))
    .map((o) => o.name);

  const isFtsManaged = (name: string): boolean =>
    virtualTables.some((vt) => name === vt || name.startsWith(`${vt}_`));

  return objects
    .filter((o) => o.type === 'table')
    .map((o) => o.name)
    .filter((name) => !name.startsWith('sqlite_') && !isFtsManaged(name));
}

describe('issue #245 — every schema table is classified as synced or explicitly not-synced', () => {
  let driver: MemoryDriver;
  let tables: string[];

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    const objects = await driver.query<SchemaObject>(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name;",
    );
    tables = classifiableTables(objects);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('sanity-checks that the schema enumeration found the tables we expect', () => {
    // Guards against the whole test silently passing because the query returned nothing.
    expect(tables.length).toBeGreaterThan(30);
    expect(tables).toContain('items');
    expect(tables).toContain('kit_components'); // the table issue #151 lost — must be present and classified
    // The FTS index and its shadow tables are excluded, not classified.
    expect(tables).not.toContain('items_fts');
    expect(tables).not.toContain('items_fts_data');
  });

  it('places every table in exactly one classification bucket', () => {
    const buckets: Record<string, readonly string[]> = {
      SYNC_TABLES,
      ITEM_TAGS_TABLE: [ITEM_TAGS_TABLE],
      LOCATION_TAGS_TABLE: [LOCATION_TAGS_TABLE],
      ITEM_REGIONS_TABLE: [ITEM_REGIONS_TABLE],
      ITEM_HISTORY_TABLE: [ITEM_HISTORY_TABLE],
      NOT_SYNCED,
    };

    const bucketsFor = (table: string): string[] =>
      Object.entries(buckets)
        .filter(([, members]) => members.includes(table))
        .map(([bucket]) => bucket);

    const unclassified = tables.filter((t) => bucketsFor(t).length === 0);
    const multiClassified = tables
      .map((t) => ({ table: t, in: bucketsFor(t) }))
      .filter((r) => r.in.length > 1);

    // Reported as data so a failure names the offending tables, not just a count.
    expect({ unclassified, multiClassified }).toEqual({ unclassified: [], multiClassified: [] });
  });

  it('keeps the NOT_SYNCED allow-list free of stale entries', () => {
    // A table renamed or dropped from the schema must not linger in the allow-list, or it would
    // silently license a name that no longer exists.
    const stale = NOT_SYNCED.filter((t) => !tables.includes(t));
    expect(stale).toEqual([]);
  });

  it('never lists a table as both synced and not-synced', () => {
    const syncedish = new Set<string>([
      ...SYNC_TABLES,
      ITEM_TAGS_TABLE,
      LOCATION_TAGS_TABLE,
      ITEM_REGIONS_TABLE,
      ITEM_HISTORY_TABLE,
    ]);
    const overlap = NOT_SYNCED.filter((t) => syncedish.has(t));
    expect(overlap).toEqual([]);
  });
});
