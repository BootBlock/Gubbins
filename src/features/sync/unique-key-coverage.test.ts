/**
 * Drift guard for {@link UNIQUE_KEY_COVERAGE} (issue #603), modelled on the one `FK_REFS` has
 * had since #152.
 *
 * §7.5 resolves a natural-key collision only for the tables `UNIQUE_KEY_SPECS` names, and that
 * registry is a hand-written list. Nothing about adding a table to {@link SYNC_TABLES} — or a
 * UNIQUE index to one already there — makes the compiler ask whether it belongs in the registry,
 * so an omission is invisible until two devices trip the index and the whole atomic merge rolls
 * back. That is precisely what happened to `suppliers`: it arrived with #384 carrying
 * `idx_suppliers_name_key` over random-UUID ids, was never registered, and bricked sync for any
 * pair of devices that recorded a part or an order from the same supplier.
 *
 * So rather than trusting the registry by hand, read the real built schema through
 * `PRAGMA index_list` / `index_xinfo` and assert that every UNIQUE index on a synced table which
 * *could* collide is either registered with the right columns, or exempted below with the reason
 * it cannot.
 *
 * Two indexes are out of scope by construction:
 *
 *  - the implicit primary-key index (`origin: 'pk'`), which the `ON CONFLICT(id)` upsert already
 *    targets — resolving it is what the LWW pass itself does;
 *  - a **partial** index (`WHERE …`), which constrains a flag rather than an identity. Those are
 *    the one-of-N repairs (`locations.is_default`, the two `supplier_parts` flags), settled by
 *    `flagRepairs` / `defaultLocationWinnerId` ahead of the upserts instead.
 *
 * The collation is checked alongside the columns. A spec that folds a column the index declares
 * BINARY — or fails to fold one it declares NOCASE — compares on a key the database does not,
 * which is how a resolution that looks correct still leaves the constraint it was written to
 * avoid.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { UNIQUE_KEY_COVERAGE } from './unique-keys';

/** A row of `PRAGMA index_list(<table>)`. */
interface IndexRow {
  readonly name: string;
  readonly unique: number; // 1 when the index enforces uniqueness
  readonly origin: string; // 'c' = CREATE INDEX, 'u' = UNIQUE constraint, 'pk' = primary key
  readonly partial: number; // 1 when the index carries a WHERE clause
}

/** A row of `PRAGMA index_xinfo(<index>)`. */
interface IndexColumnRow {
  readonly name: string | null; // null for the implicit rowid column
  readonly coll: string; // the column's collation in this index — 'BINARY' or 'NOCASE'
  readonly key: number; // 1 for a key column, 0 for an auxiliary one
}

/** One UNIQUE index of a synced table that a merge could collide on. */
interface SchemaUniqueIndex {
  readonly table: SyncTable;
  readonly index: string;
  readonly columns: readonly string[];
  /** Of those, the ones the index declares `COLLATE NOCASE`. */
  readonly nocase: readonly string[];
}

/** Indexes deliberately left unregistered, each with the reason it cannot brick a merge. */
const EXEMPT: Readonly<Record<string, string>> = {
  // Both ids are derived from the natural key itself, so two devices creating "the same" row
  // converge on one id and the collision never exists — ordinary LWW settles it. Registering
  // them would be resolving a contest that cannot be held.
  'item_stock(item_id,location_id)': 'id is derived from the key, so both devices mint the same id',
  'stock_batches(item_id,location_id,batch_key)':
    'id is derived from the key, so both devices mint the same id',
  // A token hash is not a natural key a user can retype: it is the SHA-256 of a value minted
  // from `crypto.getRandomValues`, so two devices cannot independently arrive at one. A
  // collision here would mean the hash itself had collided, which no re-key could repair.
  'api_tokens(token_hash)': 'hash of a random secret; two devices cannot invent the same one',
};

/** The `table(col,col)` key both the schema and the registry are compared under. */
const keyOf = (table: string, columns: readonly string[]) => `${table}(${columns.join(',')})`;

describe('UNIQUE_KEY_SPECS covers the real schema (#603)', () => {
  let driver: MemoryDriver;
  let schemaIndexes: SchemaUniqueIndex[];

  beforeAll(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    schemaIndexes = [];
    for (const table of SYNC_TABLES) {
      const indexes = await driver.query<IndexRow>(`PRAGMA index_list(${table});`);
      for (const index of indexes) {
        if (index.unique !== 1) continue;
        if (index.origin === 'pk') continue; // the upsert's own conflict target
        if (index.partial === 1) continue; // a flag, repaired by `flagRepairs` instead
        const columns = (await driver.query<IndexColumnRow>(`PRAGMA index_xinfo(${index.name});`))
          .filter((c) => c.key === 1 && c.name !== null)
          .map((c) => ({ name: c.name as string, nocase: c.coll.toUpperCase() === 'NOCASE' }));
        schemaIndexes.push({
          table,
          index: index.name,
          columns: columns.map((c) => c.name),
          nocase: columns.filter((c) => c.nocase).map((c) => c.name),
        });
      }
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('reads the schema it is asserting about', () => {
    // A misread PRAGMA would leave the list empty and every assertion below vacuously true.
    expect(schemaIndexes.length).toBeGreaterThan(0);
    expect(schemaIndexes.map((i) => i.index)).toContain('idx_suppliers_name_key');
  });

  it('registers or exempts every collidable UNIQUE index', () => {
    const registered = new Set(UNIQUE_KEY_COVERAGE.map((spec) => keyOf(spec.table, spec.columns)));
    const unhandled = schemaIndexes
      .map((index) => keyOf(index.table, index.columns))
      .filter((key) => !registered.has(key) && EXEMPT[key] === undefined);

    expect(unhandled).toEqual([]);
  });

  it('folds exactly the columns each index declares NOCASE', () => {
    const declared = new Map(schemaIndexes.map((i) => [keyOf(i.table, i.columns), i.nocase]));
    const mismatched = UNIQUE_KEY_COVERAGE.filter((spec) => {
      const key = keyOf(spec.table, spec.columns);
      const nocase = declared.get(key);
      return nocase !== undefined && nocase.join(',') !== [...spec.nocase].join(',');
    }).map((spec) => keyOf(spec.table, spec.columns));

    expect(mismatched).toEqual([]);
  });

  it('gives every deferred retirement a column to park on', () => {
    // `retireAfterUpserts` frees the natural key by parking the loser on it, so a spec that sets
    // the flag without naming a `parkColumn` would quietly fall back to deleting the row up
    // front — the very cascade the flag exists to avoid, with nothing to show it was skipped.
    const unparked = UNIQUE_KEY_COVERAGE.filter(
      (spec) => spec.retireAfterUpserts && spec.parkColumn === undefined,
    ).map((spec) => spec.table);

    expect(unparked).toEqual([]);
  });

  it('carries no spec for an index the schema no longer declares', () => {
    const inSchema = new Set(schemaIndexes.map((i) => keyOf(i.table, i.columns)));
    const stale = UNIQUE_KEY_COVERAGE.map((spec) => keyOf(spec.table, spec.columns)).filter(
      (key) => !inSchema.has(key),
    );

    expect(stale).toEqual([]);
  });

  it('exempts nothing the schema no longer declares', () => {
    const inSchema = new Set(schemaIndexes.map((i) => keyOf(i.table, i.columns)));
    const stale = Object.keys(EXEMPT).filter((key) => !inSchema.has(key));

    expect(stale).toEqual([]);
  });
});
